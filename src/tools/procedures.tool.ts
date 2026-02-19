import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  NoPredefinedProceduresError,
  searchForProcedures,
} from "@/03repo/procedure/vectorStore.js";

/**
 * Tool to retrieve procedures for a given query.
 * Returns the formatted procedures list string.
 */
export const proceduresQueryTool = tool(
  async ({ query }: { query: string }) => {
    try {
      const procedures = await searchForProcedures(query);
      if (!procedures || procedures.length === 0) {
        console.debug(
          `[ProcedureQueryTool] No procedures found for query "${query}".`
        );
        return "No procedures found, try a different query.";
      }

      const procedureString = procedures.map((p) => `${p.name}`).join("\n");
      console.debug(
        `[ProcedureQueryTool] Found procedures for query "${query}":\n${procedureString}`
      );
      return procedureString;
    } catch (error) {
      if (error instanceof NoPredefinedProceduresError) {
        console.debug(
          "[ProcedureQueryTool] No predefined procedures specified"
        );
        return "No predefined procedures available to search. Please generate procedures yourself.";
      }

      throw error;
    }
  },
  {
    name: "query_procedures",
    description:
      "Queries predefined procedures based by their name. Returns a list of procedures.",

    schema: z.object({
      query: z
        .string()
        .describe(
          "The search string for which to query in the procedure names."
        ),
    }),
  }
);
