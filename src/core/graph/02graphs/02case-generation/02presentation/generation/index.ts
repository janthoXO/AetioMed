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
import type { ModalityProvider } from "@/core/graph/modality/ports.js";
import { buildChiefComplaintGraph } from "./chiefComplaintGraph.js";
import { buildAnamnesisGraph } from "./anamnesisGraph.js";

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

// `patient` stays a single function node — it is deliberately NOT a
// subgraph, unlike `chiefComplaintGraph`/`anamnesisGraph` below (issue 13
// §1). `patient` is not a `ContentPart[]` field: issue 11 converted exactly
// three fields (`chiefComplaint`, `anamnesis[].answer`, `procedures[].result`)
// and `patient` stayed a structured `Patient` object (name, age, gender,
// height, weight). It is demographic *data*, not renderable *content* —
// there is no `alt` to render, and forcing it through a modality provider
// would mean either breaking `PatientSchema` or wrapping structured data in
// a text part that nothing consumes as text. So only two of the three
// fields the issue named got subgraphs; this is why.
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

// `chief_complaint_generate` and `anamnesis_generate` are compiled
// subgraphs (`chiefComplaintGraph.ts`, `anamnesisGraph.ts`) — both are
// `ContentPart[]` fields (issue 11), so both earn the
// generate/decide/render internal control flow issue 13 introduces.
// `procedures[].result` is also `ContentPart[]` but is produced in the
// procedure phase, not here — out of scope for this issue; a natural
// follow-up.

// ─── graph ────────────────────────────────────────────────────────────────────

export function buildFieldGenerationGraph(
  runtime: GraphRuntime,
  modalityRegistry: ModalityProvider[],
  traceNode: ReturnType<typeof createTraceNode>
) {
  return (
    new StateGraph(GenerationGraphStateSchema, RequestContextSchema)
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
      // Compiled subgraphs are mounted directly, not wrapped in `traceNode`
      // (see its doc comment: only plain node functions are callable that
      // way) — each subgraph traces its own internal nodes instead.
      .addNode(
        "chief_complaint_generate",
        // Scoped to match the mount name — see `nodeWrapper.ts`'s
        // `TraceNodeFn.scope` doc comment (issue 15 §3/§4).
        buildChiefComplaintGraph(
          runtime,
          modalityRegistry,
          traceNode.scope("chief_complaint_generate")
        )
      )
      .addNode(
        "anamnesis_generate",
        buildAnamnesisGraph(
          runtime,
          modalityRegistry,
          traceNode.scope("anamnesis_generate")
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
      .compile()
  );
}
