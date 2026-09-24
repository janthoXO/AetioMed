import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { UserInstructions } from "@/core/graph/models/UserInstructions.js";
import type { LanguageDetector } from "./port.js";
import { mapIsoToLanguage } from "./mapping.js";
import { detectLanguageViaLlm } from "./llmFallback.js";

/** Below this length n-gram detector is unreliable: skip to step 4. */
const MIN_DETECTION_TEXT_LENGTH = 30;

/**
 * Below this confidence top candidate is noise. Clean sentences score ~1.0,
 * short/ambiguous ones ~0.1-0.2.
 */
const MIN_DETECTION_CONFIDENCE = 0.5;

export const DEFAULT_LANGUAGE = "English";

export interface ResolveLanguageOptions {
  /** Step 1 — `req.language`, if the caller supplied one. */
  explicitLanguage: string | undefined;
  /** Detected on, never diagnosis name: ICD-only names come from English catalogue (circular), and names are short/Latin. */
  userInstructions: UserInstructions | undefined;
  /** The deployment's configured `LANGUAGES` set (config.ts). */
  languages: readonly string[];
  /** `LANGUAGE_AUTO_DETECT` — gates steps 2 and 3 together. */
  autoDetect: boolean;
  /** `LANGUAGE_DETECT_LLM_FALLBACK` — step 3's own additional opt-in. */
  llmFallbackEnabled: boolean;
  detector: LanguageDetector;
  runtime: GraphRuntime;
}

/** Concatenate per-field string values into one blob for detection. */
function concatenateUserInstructions(
  userInstructions: UserInstructions | undefined
): string {
  if (!userInstructions) return "";
  return Object.values(userInstructions)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/**
 * Laddered resolver, run once per request before `runWithContext` binds language:
 *
 * ```
 * 1. language explicitly provided       -> use it                      (no cost)
 * 2. deterministic n-gram detector      -> use it if above threshold   (no cost, offline)
 * 3. LLM fallback, only if enabled      -> one cheap call              (rare, opt-in)
 * 4. otherwise                          -> configured default (English)
 * ```
 *
 * Lives outside graph: result selects ports bound before invoke.
 */
export async function resolveLanguage(
  opts: ResolveLanguageOptions
): Promise<string> {
  const {
    explicitLanguage,
    userInstructions,
    languages,
    autoDetect,
    llmFallbackEnabled,
    detector,
    runtime,
  } = opts;

  // Step 1.
  if (explicitLanguage) return explicitLanguage;

  if (!autoDetect) return DEFAULT_LANGUAGE;

  const text = concatenateUserInstructions(userInstructions);
  if (text.length < MIN_DETECTION_TEXT_LENGTH) return DEFAULT_LANGUAGE;

  // Step 2.
  const detected = detector.detect(text);
  if (detected && detected.confidence >= MIN_DETECTION_CONFIDENCE) {
    const mapped = mapIsoToLanguage(detected.iso, languages);
    if (mapped) return mapped;
  }

  // Step 3.
  if (llmFallbackEnabled) {
    const viaLlm = await detectLanguageViaLlm(runtime, text, languages);
    if (viaLlm) return viaLlm;
  }

  // Step 4.
  return DEFAULT_LANGUAGE;
}
