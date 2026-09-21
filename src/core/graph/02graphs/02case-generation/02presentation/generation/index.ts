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

// The outline arrives as input (#159): it is produced by the plan graph
// (`../../01plan/`) and handed to the case graph, so this graph only fans
// it out to the field generators.
const GenerationGraphStateSchema = CaseGenerationStateSchema.extend({
  outline: z.string(),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

// This graph is `addNode`'d into `buildCaseGenerationGraph` as
// `presentation_phase` (issue 17 §1). `.pick()` off this graph's own state
// schema, not a hand-written duplicate, so the picked channel keeps its
// identical reducer registration. `outline` is input only now — the parent
// already holds it for the procedure phase.
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

/**
 * A join point produces no update — `patient_generate`,
 * `chief_complaint_generate` and `anamnesis_generate` have already written
 * `case` themselves, so `case_fan_in` has nothing left to contribute (issue
 * 17 §2a). It used to be `passthrough`, returning the whole incoming state as
 * its update; that made every channel in `GenerationGraphStateSchema` a
 * "write" on this node, which only avoided `INVALID_CONCURRENT_GRAPH_UPDATE`
 * because it runs alone in its own superstep — and it made the `case`
 * reducer merge the case into itself for no reason. Its trace payload is
 * correctly `{}`: the assembled case is already visible at the phase
 * boundary, so there is nothing to invent here.
 */
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
      // Compiled subgraphs are mounted directly, not wrapped in `traceNode`
      // (see its doc comment: only plain node functions are callable that
      // way) — each subgraph traces its own internal nodes instead.
      .addNode(
        "chief_complaint_generate",
        // Scoped to match the mount name — see `nodeWrapper.ts`'s
        // `TraceNodeFn.scope` doc comment (issue 15 §3/§4).
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
