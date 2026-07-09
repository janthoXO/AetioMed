import {
  Command,
  END,
  Send,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { bus } from "@/core/graph/index.js";
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
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";
import { renderUserInstructions } from "@/core/graph/utils/prompt.js";

const OBVIOUSNESS_MAX_ITERATIONS = 2;

const GenerationGraphStateSchema = CaseGenerationStateSchema.extend({
  outline: z.string(),
  /** Iterations remaining before the current outline is accepted as-is. */
  obviousnessIterationsRemaining: z
    .number()
    .default(OBVIOUSNESS_MAX_ITERATIONS),
  /** Feedback from the last obviousness evaluation, fed into regeneration. */
  obviousnessFeedback: z.array(z.string()).default([]),
});

type GenerationGraphState = z.infer<typeof GenerationGraphStateSchema>;

// ─── blueprint node ───────────────────────────────────────────────────────────

async function generateCaseOutline(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<GenerationGraphState, "outline">> {
  const outline = await fieldGenerationBlueprintTools.generateCaseOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        generationFlags: state.generationFlags,
        symptoms: state.symptoms,
        difficulty: state.difficulty,
        userInstructions: renderUserInstructions(state.userInstructions),
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating case outline: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Case outline generated:\n\`\`\` ${outline}\`\`\``,
  });
  return { outline };
}

// ─── obviousness evaluate / regenerate loop ──────────────────────────────────

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

async function outlineEvaluate(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  if (state.obviousnessIterationsRemaining <= 0) {
    bus.emit("Generation Log", {
      logLevel: "info",
      timestamp: new Date().toISOString(),
      msg: `[GenerationGraph] Obviousness iteration cap reached — proceeding with current outline.`,
    });
    return new Command({ goto: buildFieldGenerationSends(state) });
  }

  const evaluation =
    await fieldGenerationBlueprintTools.evaluateOutlineObviousness
      .invoke(
        {
          diagnosis: state.diagnosis,
          outline: state.outline,
          difficulty: state.difficulty,
          userInstructions: renderUserInstructions(state.userInstructions),
        },
        runtime?.context
      )
      .catch((error) => {
        bus.emit("Generation Log", {
          logLevel: "error",
          timestamp: new Date().toISOString(),
          msg: `[GenerationGraph] Error evaluating outline obviousness: ${error}`,
        });
        throw error;
      });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Obviousness evaluation (${state.obviousnessIterationsRemaining} iter left):\n\`\`\`json\n${JSON.stringify(evaluation, null, 2)}\n\`\`\``,
  });

  if (!evaluation.tooObvious) {
    return new Command({ goto: buildFieldGenerationSends(state) });
  }

  const feedback = evaluation.suggestion
    ? [...evaluation.reasons, evaluation.suggestion]
    : evaluation.reasons;

  return new Command({
    update: { obviousnessFeedback: feedback },
    goto: "outline_regenerate",
  });
}

async function outlineRegenerate(
  state: GenerationGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  const outline = await fieldGenerationBlueprintTools.generateCaseOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        generationFlags: state.generationFlags,
        symptoms: state.symptoms,
        difficulty: state.difficulty,
        userInstructions: renderUserInstructions(state.userInstructions),
        feedback: state.obviousnessFeedback,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error regenerating case outline: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Case outline regenerated:\n\`\`\` ${outline}\`\`\``,
  });

  return new Command({
    update: {
      outline,
      obviousnessIterationsRemaining: state.obviousnessIterationsRemaining - 1,
    },
    goto: "outline_evaluate",
  });
}

// ─── fan-out field nodes ──────────────────────────────────────────────────────

type PatientNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

async function generatePatient(
  state: PatientNodeInput,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "patient">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Generating patient…`,
  });
  const patient = await generationTools.generatePatientFromOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: renderUserInstructions(state.userInstructions),
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating patient: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Patient generated:\n\`\`\`json\n${JSON.stringify(patient, null, 2)}\n\`\`\``,
  });
  return { case: { patient } };
}

type ChiefComplaintNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

async function generateChiefComplaint(
  state: ChiefComplaintNodeInput,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "chiefComplaint">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Generating chief complaint…`,
  });
  const chiefComplaint = await generationTools.generateChiefComplaintFromOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: renderUserInstructions(state.userInstructions),
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating chief complaint: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Chief complaint generated:\n\`\`\` ${chiefComplaint}\`\`\``,
  });
  return { case: { chiefComplaint } };
}

type AnamnesisNodeInput = Pick<
  GenerationGraphState,
  "diagnosis" | "outline" | "userInstructions"
>;

async function generateAnamnesis(
  state: AnamnesisNodeInput,
  runtime?: Runtime<RequestContext>
): Promise<PickNested<GenerationGraphState, "case", "anamnesis">> {
  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Generating anamnesis…`,
  });
  const anamnesis = await generationTools.generateAnamnesisFromOutline
    .invoke(
      {
        diagnosis: state.diagnosis,
        outline: state.outline,
        userInstructions: renderUserInstructions(state.userInstructions),
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        logLevel: "error",
        timestamp: new Date().toISOString(),
        msg: `[GenerationGraph] Error generating anamnesis: ${error}`,
      });
      throw error;
    });

  bus.emit("Generation Log", {
    logLevel: "info",
    timestamp: new Date().toISOString(),
    msg: `[GenerationGraph] Anamnesis generated:\n\`\`\`json\n${JSON.stringify(anamnesis, null, 2)}\n\`\`\``,
  });
  return { case: { anamnesis } };
}

// ─── graph ────────────────────────────────────────────────────────────────────

export const fieldGenerationGraph = new StateGraph(
  GenerationGraphStateSchema,
  RequestContextSchema
)
  .addNode(
    "case_outline_generate",
    traceNode(
      "case_outline_generate",
      generateCaseOutline,
      "Generating case outline"
    )
  )
  .addNode(
    "outline_evaluate",
    traceNode(
      "outline_evaluate",
      outlineEvaluate,
      "Checking case is not too obvious"
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
      outlineRegenerate,
      "Regenerating case outline"
    ),
    { ends: ["outline_evaluate"] }
  )
  .addNode(
    "patient_generate",
    traceNode("patient_generate", generatePatient, "Generating patient")
  )
  .addNode(
    "chief_complaint_generate",
    traceNode(
      "chief_complaint_generate",
      generateChiefComplaint,
      "Generating chief complaint"
    )
  )
  .addNode(
    "anamnesis_generate",
    traceNode("anamnesis_generate", generateAnamnesis, "Generating anamnesis")
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
