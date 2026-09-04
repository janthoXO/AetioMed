import {
  Command,
  END,
  Send,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { passthrough } from "@/core/graph/02graphs/graph.utils.js";
import type { PickNested } from "@/core/graph/utils/pickNested.js";
import { fieldGenerationBlueprintTools } from "./tools.js";
import { generationTools } from "../../tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const OUTLINE_EVALUATION_MAX_ITERATIONS = 2;

const GenerationGraphStateSchema = CaseGenerationStateSchema.extend({
  outline: z.string(),
  /** Iterations remaining before the current outline is accepted as-is. */
  outlineEvaluationIterationsRemaining: z
    .number()
    .default(OUTLINE_EVALUATION_MAX_ITERATIONS),
  /** Feedback from the last outline evaluation, fed into the revision. */
  outlineFeedback: z.array(z.string()).default([]),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

// ─── blueprint node ───────────────────────────────────────────────────────────

function makeGenerateCaseOutline(runtime: GraphRuntime) {
  return async function generateCaseOutline(
    state: GenerationGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Pick<GenerationGraphState, "outline">> {
    const outline = await fieldGenerationBlueprintTools.generateCaseOutline
      .invoke(
        {
          diagnosis: state.diagnosis,
          generationFlags: state.generationFlags,
          basisFragments: state.basisFragments,
          difficulty: state.difficulty,
          userInstructions: renderUserInstructions(state.userInstructions),
        },
        runtime,
        lgRuntime?.context
      )
      .catch((error) => {
        runtime.log.error(
          `[GenerationGraph] Error generating case outline: ${error}`
        );
        throw error;
      });

    runtime.log.info(
      `[GenerationGraph] Case outline generated:\n\`\`\` ${outline}\`\`\``
    );
    return { outline };
  };
}

// ─── outline evaluate (obviousness + consistency) / regenerate loop ──────────

function filterUserInstructions(
  userInstructions: GenerationGraphState["userInstructions"],
  keys: string[]
) {
  return userInstructions
    ? Object.fromEntries(
        Object.entries(userInstructions).filter(([k]) => keys.includes(k))
      )
    : undefined;
}

/** Builds the fan-out Sends to the field generators once the outline is accepted. */
function buildFieldGenerationSends(state: GenerationGraphState): Send[] {
  const sends: Send[] = [];

  if (state.generationFlags.includes("patient")) {
    sends.push(
      new Send("patient_generate", {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: filterUserInstructions(state.userInstructions, [
          "patient",
          "general",
        ]),
      })
    );
  }
  if (state.generationFlags.includes("chiefComplaint")) {
    sends.push(
      new Send("chief_complaint_generate", {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: filterUserInstructions(state.userInstructions, [
          "chiefComplaint",
          "general",
        ]),
      })
    );
  }
  if (state.generationFlags.includes("anamnesis")) {
    sends.push(
      new Send("anamnesis_generate", {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: filterUserInstructions(state.userInstructions, [
          "anamnesis",
          "general",
        ]),
      })
    );
  }

  return sends;
}

function makeOutlineEvaluate(runtime: GraphRuntime) {
  return async function outlineEvaluate(
    state: GenerationGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    if (state.outlineEvaluationIterationsRemaining <= 0) {
      runtime.log.info(
        `[GenerationGraph] Outline evaluation iteration cap reached — proceeding with current outline.`
      );
      return new Command({ goto: buildFieldGenerationSends(state) });
    }

    const evaluation = await fieldGenerationBlueprintTools.evaluateOutline
      .invoke(
        {
          diagnosis: state.diagnosis,
          outline: state.outline,
          difficulty: state.difficulty,
          userInstructions: renderUserInstructions(state.userInstructions),
        },
        runtime,
        lgRuntime?.context
      )
      .catch((error) => {
        runtime.log.error(
          `[GenerationGraph] Error evaluating outline: ${error}`
        );
        throw error;
      });

    runtime.log.info(
      `[GenerationGraph] Outline evaluation (${state.outlineEvaluationIterationsRemaining} iter left):\n\`\`\`json\n${JSON.stringify(evaluation, null, 2)}\n\`\`\``
    );

    if (evaluation.accepted) {
      return new Command({ goto: buildFieldGenerationSends(state) });
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
    state: GenerationGraphState,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<Command> {
    const outline = await fieldGenerationBlueprintTools.generateCaseOutline
      .invoke(
        {
          diagnosis: state.diagnosis,
          generationFlags: state.generationFlags,
          basisFragments: state.basisFragments,
          difficulty: state.difficulty,
          userInstructions: renderUserInstructions(state.userInstructions),
          feedback: state.outlineFeedback,
          previousOutline: state.outline,
        },
        runtime,
        lgRuntime?.context
      )
      .catch((error) => {
        runtime.log.error(
          `[GenerationGraph] Error regenerating case outline: ${error}`
        );
        throw error;
      });

    runtime.log.info(
      `[GenerationGraph] Case outline regenerated:\n\`\`\` ${outline}\`\`\``
    );

    return new Command({
      update: {
        outline,
        outlineEvaluationIterationsRemaining:
          state.outlineEvaluationIterationsRemaining - 1,
      },
      goto: "outline_evaluate",
    });
  };
}

// ─── fan-out field nodes ──────────────────────────────────────────────────────

type PatientNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

function makeGeneratePatient(runtime: GraphRuntime) {
  return async function generatePatient(
    state: PatientNodeInput,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<PickNested<GenerationGraphState, "case", "patient">> {
    runtime.log.info(`[GenerationGraph] Generating patient…`);
    const patient = await generationTools.generatePatientFromOutline
      .invoke(
        {
          diagnosis: state.diagnosis,
          outline: state.outline,
          userInstructions: renderUserInstructions(state.userInstructions),
        },
        runtime,
        lgRuntime?.context
      )
      .catch((error) => {
        runtime.log.error(
          `[GenerationGraph] Error generating patient: ${error}`
        );
        throw error;
      });

    runtime.log.info(
      `[GenerationGraph] Patient generated:\n\`\`\`json\n${JSON.stringify(patient, null, 2)}\n\`\`\``
    );
    return { case: { patient } };
  };
}

type ChiefComplaintNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

function makeGenerateChiefComplaint(runtime: GraphRuntime) {
  return async function generateChiefComplaint(
    state: ChiefComplaintNodeInput,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<PickNested<GenerationGraphState, "case", "chiefComplaint">> {
    runtime.log.info(`[GenerationGraph] Generating chief complaint…`);
    const chiefComplaint =
      await generationTools.generateChiefComplaintFromOutline
        .invoke(
          {
            diagnosis: state.diagnosis,
            outline: state.outline,
            userInstructions: renderUserInstructions(state.userInstructions),
          },
          runtime,
          lgRuntime?.context
        )
        .catch((error) => {
          runtime.log.error(
            `[GenerationGraph] Error generating chief complaint: ${error}`
          );
          throw error;
        });

    runtime.log.info(
      `[GenerationGraph] Chief complaint generated:\n\`\`\` ${chiefComplaint}\`\`\``
    );
    return { case: { chiefComplaint } };
  };
}

type AnamnesisNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

function makeGenerateAnamnesis(runtime: GraphRuntime) {
  return async function generateAnamnesis(
    state: AnamnesisNodeInput,
    lgRuntime?: Runtime<RequestContext>
  ): Promise<PickNested<GenerationGraphState, "case", "anamnesis">> {
    runtime.log.info(`[GenerationGraph] Generating anamnesis…`);
    const anamnesis = await generationTools.generateAnamnesisFromOutline
      .invoke(
        {
          diagnosis: state.diagnosis,
          outline: state.outline,
          userInstructions: renderUserInstructions(state.userInstructions),
        },
        runtime,
        lgRuntime?.context
      )
      .catch((error) => {
        runtime.log.error(
          `[GenerationGraph] Error generating anamnesis: ${error}`
        );
        throw error;
      });

    runtime.log.info(
      `[GenerationGraph] Anamnesis generated:\n\`\`\`json\n${JSON.stringify(anamnesis, null, 2)}\n\`\`\``
    );
    return { case: { anamnesis } };
  };
}

// ─── graph ────────────────────────────────────────────────────────────────────

export function buildFieldGenerationGraph(
  runtime: GraphRuntime,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return new StateGraph(GenerationGraphStateSchema, RequestContextSchema)
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
      {
        ends: [
          "outline_regenerate",
          "patient_generate",
          "chief_complaint_generate",
          "anamnesis_generate",
        ],
      }
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
    .addNode(
      "patient_generate",
      traceNode(
        "patient_generate",
        makeGeneratePatient(runtime),
        "Generating patient"
      )
    )
    .addNode(
      "chief_complaint_generate",
      traceNode(
        "chief_complaint_generate",
        makeGenerateChiefComplaint(runtime),
        "Generating chief complaint"
      )
    )
    .addNode(
      "anamnesis_generate",
      traceNode(
        "anamnesis_generate",
        makeGenerateAnamnesis(runtime),
        "Generating anamnesis"
      )
    )
    .addNode(
      "case_fan_in",
      traceNode(
        "case_fan_in",
        passthrough<GenerationGraphState>,
        "Assembling case fields"
      )
    )

    .addEdge(START, "case_outline_generate")
    .addEdge("case_outline_generate", "outline_evaluate")
    .addEdge("patient_generate", "case_fan_in")
    .addEdge("chief_complaint_generate", "case_fan_in")
    .addEdge("anamnesis_generate", "case_fan_in")
    .addEdge("case_fan_in", END)
    .compile();
}
