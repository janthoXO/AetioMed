import { promptLanguage } from "@/core/graph/shared/domain/Language.js";
import type { RequestContext } from "@/core/graph/utils/context.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import { translateRecordKeyed } from "@/core/graph/shared/translation/translate.js";
import type { UserInstructions } from "@/core/graph/shared/domain/UserInstructions.js";

/** Free text, no catalogue or cache: translated afresh each call. Keyed by instruction keys (flag names / `"general"`), not text; two slots can hold same text. */
export async function translateUserInstructionsToEnglish(
  runtime: GraphRuntime,
  input: { userInstructions: UserInstructions; language: string },
  context?: RequestContext
): Promise<UserInstructions> {
  const { userInstructions, language } = input;
  return translateRecordKeyed(runtime, {
    logTag: "TranslateUserInstructionsToEnglish",
    taskDescription:
      "Translate the provided free-text user instructions from the given language to English.",
    contextLines: [
      `Source language: ${promptLanguage(language)}`,
      `Target language: ${promptLanguage("en")}`,
    ],
    values: userInstructions,
    context,
  });
}
