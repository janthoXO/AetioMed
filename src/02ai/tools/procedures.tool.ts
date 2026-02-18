import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  NoPredefinedProceduresError,
  searchForProcedures,
} from "@/02services/procedures.service.js";

/**
 * Tool to retrieve procedures for a given query.
 * Returns the formatted procedures list string.
 */
export const proceduresQueryTool = tool(
  async ({ query }: { query: string }) => {
    try {
      const procedures = searchForProcedures(query);
      return procedures.map((p) => `${p.name}`).join("\n");
    } catch (error) {
      if (error instanceof NoPredefinedProceduresError) {
        return "No predefined procedures available to search. Please generate procedures yourself.";
      }

      throw error;
    }
  },
  {
    name: "query_procedures",
    description:
      "Queries predefined procedures based on a search string. Returns a list of procedures with their descriptions.",

    schema: z.object({
      query: z
        .string()
        .describe("The search string for which to retrieve procedures"),
    }),
  }
);
