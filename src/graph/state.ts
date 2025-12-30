import { Annotation } from "@langchain/langgraph";
import type { Case } from "../domain-models/Case.js";
import { GenerationFlags } from "../domain-models/GenerationFlags.js";
import type { Inconsistency } from "../domain-models/Inconsistency.js";

export const GraphInput = Annotation.Root({
  /**
   * The medical diagnosis to generate a case for
   */
  diagnosis: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * Optional context to guide case generation
   */
  context: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  generationFlags: Annotation<number>({
    reducer: (_, update) => update,
    default: () => GenerationFlags.All,
  }),
});

export type GraphInput = typeof GraphInput.State;

export type CaseWithDraftIndex = Case & { draftIndex: number };

/**
 * The main graph state using Annotation.Root
 *
 * This state flows through all nodes and accumulates results from parallel branches.
 */
export const AgentState = Annotation.Root({
  /**
   * The medical diagnosis to generate a case for
   */
  diagnosis: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * Optional context to guide case generation
   */
  context: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * Generation flags to control case generation behavior
   */
  generationFlags: Annotation<number>({
    reducer: (_, update) => update,
    default: () => GenerationFlags.All,
  }),

  /**
   * Array of generated case drafts from parallel generation nodes.
   * Uses appendReducer to merge results from multiple Send() branches.
   */
  cases: Annotation<CaseWithDraftIndex[]>({
    // append to collcet cases from parallel branches
    reducer: (
      current: CaseWithDraftIndex[],
      update:
        | CaseWithDraftIndex[]
        | { replace: true; cases: CaseWithDraftIndex[] }
    ): CaseWithDraftIndex[] => {
      if (Array.isArray(update)) {
        return [...current, ...update];
      }

      return update.cases;
    },
    default: () => [],
  }),

  /**
   * Number of parallel draft generators
   */
  draftCount: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 2,
  }),

  /**
   * Size of the council for voting purposes
   */
  councileSize: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 2,
  }),

  /**
   * Map from case ID to number of votes received.
   */
  votes: Annotation<Record<string, number>>({
    // merge vote counts from parallel branches
    reducer: (
      current: Record<string, number>,
      update:
        | Record<string, number>
        | { replace: true; votes: Record<string, number> }
    ): Record<string, number> => {
      if ("replace" in update && update.replace) {
        return update.votes as Record<string, number>;
      }

      const merged = { ...current };
      for (const [key, value] of Object.entries(update)) {
        merged[key] = (merged[key] ?? 0) + value;
      }
      return merged;
    },
    default: () => ({}),
  }),

  /**
   * Map of field name to inconsistency.
   */
  inconsistencies: Annotation<Record<string, Inconsistency[]>>({
    reducer: (_, update) => update,
    default: () => ({}),
  }),

  /**
   * Maximum remaining iterations for the refinement loop.
   * Decrements each loop to prevent infinite cycles.
   */
  consistencyIteration: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 2,
  }),
});

/**
 * Type alias for the state shape
 */
export type AgentStateType = typeof AgentState.State;

export const GraphOutput = Annotation.Root({
  case: Annotation<Case>({
    reducer: (_, update) => update,
  }),
});

export type GraphOutputType = typeof GraphOutput.State;
