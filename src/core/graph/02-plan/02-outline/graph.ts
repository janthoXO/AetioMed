import {
  Command,
  END,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import z from "zod";
import { CaseGenerationStateSchema } from "@/core/graph/shared/caseGenerationState.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import {
  evaluateOutline,
  generateCaseOutline as generateCaseOutlineGateway,
} from "./gateway.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/shared/prompt/prompt.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import {
  OutlineSegmentsSchema,
  joinOutline,
} from "@/core/graph/shared/outline/segments.js";
import { RunModeSchema } from "@/core/graph/shared/domain/RunMode.js";
import type { PromptAudience } from "@/core/graph/shared/prompt/prompt.js";

const OUTLINE_EVALUATION_MAX_ITERATIONS = 2;

/** Plan: outline plus evaluate ⇄ regenerate loop. Plan graph ends here; case graph starts from a handed-in outline. */
export const PlanGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  difficulty: true,
  basisFragments: true,
}).extend({
  /** Plan mode binds outline and judge to request language; normal mode English. Sandwich on: `languageOverride` keeps English either way; plan mode translates outline instead. */
  mode: RunModeSchema.default("normal"),
  outlineSegments: OutlineSegmentsSchema.default([]),
  /** Judge accepted `outlineSegments`. `false` after iteration cap; caller decides. */
  outlineAccepted: z.boolean().default(false),
  /** Iterations remaining before the loop gives up on the judge. */
  outlineEvaluationIterationsRemaining: z
    .number()
    .default(OUTLINE_EVALUATION_MAX_ITERATIONS),
  /** The judge's feedback, fed into the next revision. */
  outlineFeedback: z.array(z.string()).default([]),
});

/** `"user-facing"` binds the outline prompts to the request language. */
function audienceOf(state: PlanGraphState): PromptAudience {
  return state.mode === "plan" ? "user-facing" : "internal";
}

type PlanGraphState = z.infer<typeof PlanGraphStateSchema>;

// `.pick()` off own state schema: write surface = outline and judge verdict only.
const PlanGraphOutputSchema = PlanGraphStateSchema.pick({
  outlineSegments: true,
  outlineAccepted: true,
});

function makeGenerateCaseOutline(runtime: GraphRuntime) {
  return async function generateCaseOutline(
    state: PlanGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<PlanGraphState, "outlineSegments">> {
    const outlineSegments = await generateCaseOutlineGateway(
      runtime,
      state.diagnosis,
      state.basisFragments,
      state.difficulty,
      {
        userInstructions: renderUserInstructions(state.userInstructions),
        audience: audienceOf(state),
      },
      lgRuntime?.context
    ).catch((error) => {
      runtime.log.error(`[PlanGraph] Error generating case outline: ${error}`);
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

    const evaluation = await evaluateOutline(
      runtime,
      state.diagnosis,
      joinOutline(state.outlineSegments),
      state.difficulty,
      renderUserInstructions(state.userInstructions),
      lgRuntime?.context,
      audienceOf(state)
    ).catch((error) => {
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
    const outlineSegments = await generateCaseOutlineGateway(
      runtime,
      state.diagnosis,
      state.basisFragments,
      state.difficulty,
      {
        userInstructions: renderUserInstructions(state.userInstructions),
        feedback: state.outlineFeedback,
        previousOutline: state.outlineSegments,
        audience: audienceOf(state),
      },
      lgRuntime?.context
    ).catch((error) => {
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
