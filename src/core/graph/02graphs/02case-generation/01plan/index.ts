import {
  Command,
  END,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import z from "zod";
import { CaseGenerationStateSchema } from "../state.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { fieldGenerationBlueprintTools } from "./tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import {
  OutlineSegmentsSchema,
  joinOutline,
} from "@/core/graph/outline/segments.js";

const OUTLINE_EVALUATION_MAX_ITERATIONS = 2;

/**
 * The plan: an outline and its evaluate ⇄ regenerate loop (#159). Split out
 * of the presentation phase so the pipeline can stop between "the outline
 * exists" and "fields are generated from it" — the plan graph ends here and
 * the case graph starts from an outline handed to it.
 */
export const PlanGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  difficulty: true,
  basisFragments: true,
}).extend({
  outlineSegments: OutlineSegmentsSchema.default([]),
  /**
   * Whether the judge accepted `outlineSegments`. `false` after the loop
   * ends on its iteration cap — the caller decides what that means.
   */
  outlineAccepted: z.boolean().default(false),
  /** Iterations remaining before the loop gives up on the judge. */
  outlineEvaluationIterationsRemaining: z
    .number()
    .default(OUTLINE_EVALUATION_MAX_ITERATIONS),
  /** Feedback from the last outline evaluation, fed into the revision. */
  outlineFeedback: z.array(z.string()).default([]),
});

type PlanGraphState = z.infer<typeof PlanGraphStateSchema>;

// `.pick()` off this graph's own state schema (issue 17 §1): the write
// surface is the outline and the judge's verdict, nothing else.
const PlanGraphOutputSchema = PlanGraphStateSchema.pick({
  outlineSegments: true,
  outlineAccepted: true,
});

function makeGenerateCaseOutline(runtime: GraphRuntime) {
  return async function generateCaseOutline(
    state: PlanGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<PlanGraphState, "outlineSegments">> {
    const outlineSegments =
      await fieldGenerationBlueprintTools.generateCaseOutline
        .invoke(
          {
            diagnosis: state.diagnosis,
            basisFragments: state.basisFragments,
            difficulty: state.difficulty,
            userInstructions: renderUserInstructions(state.userInstructions),
          },
          runtime,
          lgRuntime?.context
        )
        .catch((error) => {
          runtime.log.error(
            `[PlanGraph] Error generating case outline: ${error}`
          );
          throw error;
        });

    runtime.log.info(
      `[PlanGraph] Case outline generated:\n\`\`\` ${joinOutline(outlineSegments)}\`\`\``
    );
    return { outlineSegments };
  };
}

function makeOutlineEvaluate(runtime: GraphRuntime) {
  return async function outlineEvaluate(
    state: PlanGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    if (state.outlineEvaluationIterationsRemaining <= 0) {
      runtime.log.info(
        `[PlanGraph] Outline evaluation iteration cap reached — the outline was not accepted.`
      );
      return new Command({ update: { outlineAccepted: false }, goto: END });
    }

    const evaluation = await fieldGenerationBlueprintTools.evaluateOutline
      .invoke(
        {
          diagnosis: state.diagnosis,
          outline: joinOutline(state.outlineSegments),
          difficulty: state.difficulty,
          userInstructions: renderUserInstructions(state.userInstructions),
        },
        runtime,
        lgRuntime?.context
      )
      .catch((error) => {
        runtime.log.error(`[PlanGraph] Error evaluating outline: ${error}`);
        throw error;
      });

    runtime.log.info(
      `[PlanGraph] Outline evaluation (${state.outlineEvaluationIterationsRemaining} iter left):\n\`\`\`json\n${JSON.stringify(evaluation, null, 2)}\n\`\`\``
    );

    if (evaluation.accepted) {
      return new Command({ update: { outlineAccepted: true }, goto: END });
    }

    const feedback = evaluation.suggestion
      ? [...evaluation.reasons, evaluation.suggestion]
      : evaluation.reasons;

    return new Command({
      update: { outlineFeedback: feedback },
      goto: "outline_regenerate",
    });
  };
}

function makeOutlineRegenerate(runtime: GraphRuntime) {
  return async function outlineRegenerate(
    state: PlanGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    const outlineSegments =
      await fieldGenerationBlueprintTools.generateCaseOutline
        .invoke(
          {
            diagnosis: state.diagnosis,
            basisFragments: state.basisFragments,
            difficulty: state.difficulty,
            userInstructions: renderUserInstructions(state.userInstructions),
            feedback: state.outlineFeedback,
            previousOutline: state.outlineSegments,
          },
          runtime,
          lgRuntime?.context
        )
        .catch((error) => {
          runtime.log.error(
            `[PlanGraph] Error regenerating case outline: ${error}`
          );
          throw error;
        });

    runtime.log.info(
      `[PlanGraph] Case outline regenerated:\n\`\`\` ${joinOutline(outlineSegments)}\`\`\``
    );

    return new Command({
      update: {
        outlineSegments,
        outlineEvaluationIterationsRemaining:
          state.outlineEvaluationIterationsRemaining - 1,
      },
      goto: "outline_evaluate",
    });
  };
}

export function buildPlanGraph(
  runtime: GraphRuntime,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return new StateGraph(PlanGraphStateSchema, {
    context: RequestContextSchema,
    output: PlanGraphOutputSchema,
  })
    .addNode(
      "case_outline_generate",
      traceNode(
        "case_outline_generate",
        makeGenerateCaseOutline(runtime),
        "Generating case outline"
      )
    )
    .addNode(
      "outline_evaluate",
      traceNode(
        "outline_evaluate",
        makeOutlineEvaluate(runtime),
        "Evaluating case outline"
      ),
      { ends: ["outline_regenerate", END] }
    )
    .addNode(
      "outline_regenerate",
      traceNode(
        "outline_regenerate",
        makeOutlineRegenerate(runtime),
        "Regenerating case outline"
      ),
      { ends: ["outline_evaluate"] }
    )
    .addEdge(START, "case_outline_generate")
    .addEdge("case_outline_generate", "outline_evaluate")
    .compile();
}
