import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { UserInstructions } from "@/core/graph/models/UserInstructions.js";
import type { LanguageDetector } from "./port.js";
import { mapIsoToLanguage } from "./mapping.js";
import { detectLanguageViaLlm } from "./llmFallback.js";

/**
 * Below this length, an n-gram detector has too little signal to be
 * reliable — skip straight to step 4 rather than spend a call on it (issue
 * 10 §2).
 */
const MIN_DETECTION_TEXT_LENGTH = 30;

/**
 * Below this confidence, treat the detector's top candidate as noise (issue
 * 10 §5: "a hint with a confidence threshold, not an authority"). Chosen
 * from manual probing of the installed `tinyld` build: a clean single-
 * language sentence of ordinary length scores ~1.0, while a short or
 * multi-lingual-plausible phrase scores its top candidate around 0.1–0.2 —
 * 0.5 sits well clear of the ambiguous end without being so strict that
 * ordinary free text never wins step 2.
 */
const MIN_DETECTION_CONFIDENCE = 0.5;

export const DEFAULT_LANGUAGE = "English";

export interface ResolveLanguageOptions {
  /** Step 1 — `req.language`, if the caller supplied one. */
  explicitLanguage: string | undefined;
  /**
   * Detected on, never the diagnosis name (issue 10 §2 — two decisive
   * reasons: an ICD-only request's diagnosis name comes from our own
   * English catalogue, so detecting on it is circular; and diagnosis names
   * are 2-3 words and frequently Latin, e.g. "Diabetes mellitus" is
   * byte-identical in English, German and Spanish).
   */
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

/** `UserInstructions` is a record of per-field strings — concatenate its
 * values into one blob for detection (issue 10 §2). */
function concatenateUserInstructions(
  userInstructions: UserInstructions | undefined
): string {
  if (!userInstructions) return "";
  return Object.values(userInstructions)
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/**
 * The laddered resolver (issue 10 §1), run once per request in
 * `CaseGenerationService`, before `runWithContext` binds the language:
 *
 * ```
 * 1. language explicitly provided       -> use it                      (no cost)
 * 2. deterministic n-gram detector      -> use it if above threshold   (no cost, offline)
 * 3. LLM fallback, only if enabled      -> one cheap call              (rare, opt-in)
 * 4. otherwise                          -> configured default (English)
 * ```
 *
 * This lives in the communication layer, not the graph: its output
 * *selects the ports* generation binds, and binding happens before invoke —
 * a detection node inside the graph could not inform the thing its answer
 * is for. It is also request normalisation, so it sits beside the
 * ICD→name resolution `CaseGenerationService` already does.
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
