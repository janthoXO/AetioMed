import {
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
import type { PickNested } from "@/core/graph/utils/pickNested.js";
import { generationTools } from "../../tools.js";
import type { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ModalityRegistries } from "@/core/graph/modality/registry.js";
import { buildChiefComplaintGraph } from "./chiefComplaint/index.js";
import { buildAnamnesisGraph } from "./anamnesis/index.js";

// Outline arrives as input from plan graph (`../../01plan/`); this graph only fans it out.
const GenerationGraphStateSchema = CaseGenerationStateSchema.extend({
  outline: z.string(),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

// Mounted as `presentation_phase`. `.pick()` off own state schema. `outline` input only.
const GenerationOutputSchema = GenerationGraphStateSchema.pick({
  case: true,
});

// ─── fan-out ──────────────────────────────────────────────────────────────────

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

/** Builds the fan-out Sends to the field generators from the handed-in outline. */
function buildFieldGenerationSends(
  state: Pick<
    GenerationGraphState,
    "generationFlags" | "diagnosis" | "outline" | "userInstructions"
  >
): Send[] {
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

// ─── fan-out field nodes ──────────────────────────────────────────────────────

type PatientNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

// `patient` stays a plain function node, not a subgraph: structured `Patient` object, not `ContentPart[]`; no `alt` to render, nothing for a modality provider.
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

// `chief_complaint_generate`/`anamnesis_generate` are compiled subgraphs (`ContentPart[]` fields). `procedures[].result` is produced in procedure phase.

// ─── graph ────────────────────────────────────────────────────────────────────

/** Join point: no update. Field nodes already wrote `case`. Trace payload `{}`. */
export function caseFanIn(): Record<string, never> {
  return {};
}

export function buildFieldGenerationGraph(
  runtime: GraphRuntime,
  modalityRegistries: ModalityRegistries,
  traceNode: ReturnType<typeof createTraceNode>
) {
  return (
    new StateGraph(GenerationGraphStateSchema, {
      context: RequestContextSchema,
      output: GenerationOutputSchema,
    })
      .addNode(
        "patient_generate",
        traceNode(
          "patient_generate",
          makeGeneratePatient(runtime),
          "Generating patient"
        )
      )
      // Subgraphs mounted directly, not `traceNode`-wrapped; each traces its own nodes.
      .addNode(
        "chief_complaint_generate",
        // Scoped to match mount name; see `TraceNodeFn.scope` in `nodeWrapper.ts`.
        buildChiefComplaintGraph(
          runtime,
          modalityRegistries.chiefComplaint,
          traceNode.scope("chief_complaint_generate")
        )
      )
      .addNode(
        "anamnesis_generate",
        buildAnamnesisGraph(
          runtime,
          modalityRegistries.anamnesis,
          traceNode.scope("anamnesis_generate")
        )
      )
      .addNode(
        "case_fan_in",
        traceNode("case_fan_in", caseFanIn, "Assembling case fields")
      )

      .addConditionalEdges(START, buildFieldGenerationSends, [
        "patient_generate",
        "chief_complaint_generate",
        "anamnesis_generate",
      ])
      .addEdge("patient_generate", "case_fan_in")
      .addEdge("chief_complaint_generate", "case_fan_in")
      .addEdge("anamnesis_generate", "case_fan_in")
      .addEdge("case_fan_in", END)
      .compile()
  );
}
