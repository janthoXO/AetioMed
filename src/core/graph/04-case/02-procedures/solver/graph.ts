import { END, START, StateGraph, type Runtime } from "@langchain/langgraph";
import z from "zod";
import {
  RequestContextSchema,
  type RequestContext,
} from "@/core/graph/utils/context.js";
import { ProcedureRelevanceSchema } from "@/core/graph/shared/domain/Procedure.js";
import { PresentationSchema } from "../presentation.js";
import type { ProcedureStrategy, SolverMove } from "./ports.js";

/**
 * Blinded solver's child graph; state schema omits `diagnosis`. `BlindedView`
 * (`ports.ts`) is the compile-time guard; this is the runtime
 * backstop: LangGraph drops input keys not in the state schema. `.invoke()`d
 * from `blinded_step`, never `addNode`'d — exists for its input schema.
 */
const BlindedSolverStateSchema = z.object({
  presentation: PresentationSchema,
  // Projected from `plannedProcedures`; nothing rendered yet. See
  // `PreviousProcedureFinding`.
  previousProcedures: z
    .array(
      z.object({
        path: z.array(z.string()),
        name: z.string(),
        relevance: ProcedureRelevanceSchema,
        result: z.string(),
      })
    )
    .default([]),
  ruledOutDiagnoses: z.array(z.string()).default([]),
  userInstructions: z.string().optional(),
  iterationsRemaining: z.number(),
  /** Output-only: the strategy's decision, set by the graph's single node. */
  move: z.custom<SolverMove>().optional(),
});

/** Exported for `../graph.test.ts` only. */
export function buildBlindedSolverGraph(strategy: ProcedureStrategy) {
  return new StateGraph(BlindedSolverStateSchema, {
    context: RequestContextSchema,
    // Write surface declared explicitly; `move` is the only output.
    output: BlindedSolverStateSchema.pick({ move: true }),
  })
    .addNode("solve", async (state, lgRuntime?: Runtime<RequestContext>) => {
      const move = await strategy.nextStep({
        presentation: state.presentation,
        previousProcedures: state.previousProcedures,
        ruledOutDiagnoses: state.ruledOutDiagnoses,
        userInstructions: state.userInstructions,
        iterationsRemaining: state.iterationsRemaining,
        context: lgRuntime?.context,
      });
      return { move };
    })
    .addEdge(START, "solve")
    .addEdge("solve", END)
    .compile();
}
