import { END, START, StateGraph } from "@langchain/langgraph";
import { CaseGenerationStateSchema } from "../../state.js";
import z from "zod";
import { passthrough } from "@/extensions/core/02graphs/graph.utils.js";
import { RequestContextSchema } from "@/extensions/core/utils/context.js";

const ProcedureGraphStateSchema = CaseGenerationStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  case: true,
}).extend({
  procedureIterationsRemaining: z.number().default(2),
});

type ProcedureGraphState = z.infer<typeof ProcedureGraphStateSchema>;

export const procedureGraph = new StateGraph(
  ProcedureGraphStateSchema,
  RequestContextSchema
)
  .addNode("iteration_check", passthrough<ProcedureGraphState>)
  .addNode("procedure_generation", passthrough<ProcedureGraphState>)
  .addNode("iteration_decrease", (state) => {
    return {
      procedureIterationsRemaining: state.procedureIterationsRemaining - 1,
    };
  })

  .addEdge(START, "iteration_check")
  .addConditionalEdges(
    "iteration_check",
    (state) => {
      return state.procedureIterationsRemaining > 0 ? "generation" : "end";
    },
    {
      generation: "procedure_generation",
      end: END,
    }
  )
  .addConditionalEdges(
    "procedure_generation",
    () => {
      // check if procedures are already enough to make diagnosis
      return "continue";
    },
    {
      continue: "iteration_decrease",
      end: END,
    }
  )
  .addEdge("iteration_decrease", "iteration_check")
  .compile();
