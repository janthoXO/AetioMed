import {
  Command,
  END,
  START,
  StateGraph,
  type Runtime,
} from "@langchain/langgraph";
import { bus } from "@/core/graph/index.js";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import { InconsistencySchema } from "@/core/graph/models/Inconsistency.js";
import { PredefinedProcedureNames } from "@/core/graph/models/Procedure.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { inconsistencyTools } from "./tools.js";
import { traceNode } from "@/core/graph/utils/nodeWrapper.js";

const InconsistencyGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  generationFlags: true,
  case: true,
  anamnesisCategories: true,
}).extend({
  refinementIterationsRemaining: z.number().default(2),
  inconsistencies: z.array(InconsistencySchema).default([]),
});

type InconsistencyGraphState = z.infer<typeof InconsistencyGraphStateSchema>;

async function evaluate(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  if (state.refinementIterationsRemaining <= 0) {
    return new Command({ goto: END });
  }

  let inconsistencies = await inconsistencyTools.generateInconsistencies
    .invoke(
      {
        case: state.case,
        diagnosis: state.diagnosis,
        generationFlags: state.generationFlags,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[InconsistencyGraph] Error evaluating inconsistencies: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  inconsistencies = inconsistencies.filter((i) =>
    state.generationFlags.some((f) => f === i.field)
  );

  bus.emit("Generation Log", {
    msg: `[InconsistencyGraph] Found ${inconsistencies.length} inconsistencies:\n\`\`\`json\n${JSON.stringify(inconsistencies, null, 2)}\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  if (inconsistencies.length === 0) {
    return new Command({ goto: END });
  }

  return new Command({ update: { inconsistencies }, goto: "case_refine" });
}

async function caseRefine(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Command> {
  const refinedCase = await inconsistencyTools.fixCaseInconsistencies
    .invoke(
      {
        case: state.case,
        inconsistencies: state.inconsistencies,
        generationFlags: state.generationFlags,
        anamnesisCategories: state.anamnesisCategories,
        procedureNameList: PredefinedProcedureNames,
        userInstructions: state.userInstructions
          ? JSON.stringify(state.userInstructions)
          : undefined,
      },
      runtime?.context
    )
    .catch((error) => {
      bus.emit("Generation Log", {
        msg: `[InconsistencyGraph] Error refining case: ${error}`,
        logLevel: "error",
        timestamp: new Date().toISOString(),
      });
      throw error;
    });

  bus.emit("Generation Log", {
    msg: `[InconsistencyGraph] Case refined:\n\`\`\`json\n${JSON.stringify(refinedCase, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return new Command({
    update: {
      case: refinedCase,
      refinementIterationsRemaining: state.refinementIterationsRemaining - 1,
    },
    goto: "evaluate",
  });
}

export const inconsistencyGraph = new StateGraph(
  InconsistencyGraphStateSchema,
  RequestContextSchema
)
  .addNode(
    "evaluate",
    traceNode("evaluate", evaluate, "Evaluating case consistency"),
    {
      ends: ["case_refine", END],
    }
  )
  .addNode(
    "case_refine",
    traceNode("case_refine", caseRefine, "Refining case for consistency"),
    {
      ends: ["evaluate"],
    }
  )

  .addEdge(START, "evaluate")
  .compile();
