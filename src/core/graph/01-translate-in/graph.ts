import { getRequestContext } from "@/core/graph/utils/context.js";
import { translateUserInstructionsToEnglish } from "./gateway.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { Runtime } from "@langchain/langgraph";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { UserInstructions } from "@/core/graph/shared/domain/UserInstructions.js";
import { GenerationError } from "@/core/graph/errors/AppError.js";

function requiredTargetLanguage(): string {
  // Read off ALS. Node only entered when a non-English language is bound; absent = bug.
  const language = getRequestContext()?.language;
  if (!language) {
    throw new GenerationError(
      "translate-to-english reached without a language bound on the request context"
    );
  }
  return language;
}

/**
 * Plan-graph node `translate_user_instructions`: caller-supplied
 * `userInstructions` to English. A plain node, not a phase subgraph: the
 * diagnosis is resolved before the graph (#237), so this is the only
 * translate-in step left.
 */
export function makeTranslateUserInstructions(runtime: GraphRuntime) {
  return async function translateUserInstructions(
    state: { userInstructions?: UserInstructions | undefined },
    lgRuntime?: Runtime<RequestContext>
  ): Promise<{ userInstructions: UserInstructions } | undefined> {
    const language = requiredTargetLanguage();

    if (
      !state.userInstructions ||
      Object.keys(state.userInstructions).length === 0
    ) {
      return undefined;
    }

    const userInstructions = await translateUserInstructionsToEnglish(
      runtime,
      { userInstructions: state.userInstructions, language },
      lgRuntime?.context
    );
    return { userInstructions };
  };
}
