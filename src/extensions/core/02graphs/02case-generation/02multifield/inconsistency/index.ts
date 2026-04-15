import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import { bus } from "@/extensions/core/index.js";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import { InconsistencySchema } from "@/extensions/core/models/Inconsistency.js";
import {
  fixCaseInconsistencies,
  generateInconsistencies as generateInconsistenciesGateway,
} from "@/extensions/core/03aigateway/consistency.aigateway.js";
import { passthrough } from "@/extensions/core/02graphs/graph.utils.js";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/extensions/core/utils/context.js";

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

async function generateInconsistencies(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<InconsistencyGraphState, "inconsistencies">> {
  bus.emit("Generation Log", {
    msg: "[InconsistencyGraph] Starting generation of inconsistencies...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  let generatedInconsistencies = await generateInconsistenciesGateway(
    state.case,
    state.diagnosis,
    state.generationFlags,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    bus.emit("Generation Log", {
      msg: `[InconsistencyGraph] Error generating inconsistencies: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  // filter inconsistencies to only those relevant for the current generation flags
  generatedInconsistencies = generatedInconsistencies.filter((i) =>
    state.generationFlags.some((f) => f === i.field)
  );

  bus.emit("Generation Log", {
    msg: `[InconsistencyGraph] Successfully generated inconsistencies:\n\`\`\`json\n${JSON.stringify(generatedInconsistencies, null, 2)}\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { inconsistencies: generatedInconsistencies };
}

async function refineCase(
  state: InconsistencyGraphState,
  runtime?: Runtime<RequestContext>
): Promise<Pick<InconsistencyGraphState, "case">> {
  bus.emit("Generation Log", {
    msg: "[InconsistencyGraph] Starting refinement of case...",
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });
  const generatedCase = await fixCaseInconsistencies(
    state.case,
    state.inconsistencies,
    state.generationFlags,
    state.userInstructions ? JSON.stringify(state.userInstructions) : undefined,
    runtime?.context
  ).catch((error) => {
    bus.emit("Generation Log", {
      msg: `[InconsistencyGraph] Error refining case: ${error}`,
      logLevel: "error",
      timestamp: new Date().toISOString(),
    });
    throw error;
  });

  bus.emit("Generation Log", {
    msg: `[InconsistencyGraph] Successfully refined case:\n\`\`\`json\n${JSON.stringify(generatedCase, null, 2)}\n\`\`\``,
    logLevel: "info",
    timestamp: new Date().toISOString(),
  });

  return { case: generatedCase };
}

export const inconsistencyGraph = new StateGraph(
  InconsistencyGraphStateSchema,
  RequestContextSchema
)
  .addNode("iteration_check", passthrough<InconsistencyGraphState>)
  .addNode("inconsistencies_generate", generateInconsistencies)
  .addNode("case_refine", refineCase)
  .addNode("iteration_decrease", (state) => {
    console.debug(
      "[InconsistencyGraph: iteration_decrease] Decreasing refinement iterations remaining..."
    );
    state.refinementIterationsRemaining = Math.max(
      0,
      state.refinementIterationsRemaining - 1
    );
    return {
      refinementIterationsRemaining: state.refinementIterationsRemaining,
    };
  })

  .addEdge(START, "iteration_check")
  .addConditionalEdges(
    "iteration_check",
    (state) => {
      return state.refinementIterationsRemaining > 0 ? "continue" : "end";
    },
    {
      end: END,
      // inconsistencies generation should then decrease the iteration count
      continue: "inconsistencies_generate",
    }
  )
  .addEdge("inconsistencies_generate", "case_refine")
  .addEdge("case_refine", "iteration_decrease")
  .addEdge("iteration_decrease", "iteration_check")
  .compile();
