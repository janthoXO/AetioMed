import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { DiagnosisSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { GenerationFlagSchema } from "@/core/graph/shared/domain/GenerationFlags.js";
import { DifficultySchema } from "@/core/graph/shared/domain/Difficulty.js";
import { OutlineSegmentsSchema } from "@/core/graph/shared/outline/segments.js";
import { AppError } from "./graph/errors/AppError.js";

/**
 * Generation context (#272): every generator internal a later call needs,
 * handed out as an opaque string on every response and sent back unread.
 * Keeps the generator stateless (#159): no store, any replica answers.
 */
export const GenerationContextSchema = z.object({
  v: z.literal(1),
  /** Resolved: a continuation skips `resolveDiagnosis`. */
  diagnosis: DiagnosisSchema,
  difficulty: DifficultySchema.optional(),
  /** Requested flags of the first call. */
  generationFlags: z.array(GenerationFlagSchema).min(1),
  /** Fields the case has; empty while only a plan exists. */
  fields: z.array(GenerationFlagSchema),
  /** Working-language plan: English, or the request language (plan mode, sandwich off). */
  plan: OutlineSegmentsSchema,
  /**
   * What a plan-mode reviewer was shown, per segment index. A handed-back
   * segment equal to it is untouched: `plan[i]` used, no translation.
   */
  localized: z.record(z.string(), z.string()).optional(),
});

export type GenerationContext = z.infer<typeof GenerationContextSchema>;

/** A `context` that does not decode: not ours, truncated, or an old version. */
export class InvalidContextError extends AppError {
  constructor(details?: string) {
    super("Invalid generation context", "INVALID_CONTEXT", 400, details);
  }
}

/** Versioned JSON → gzip → base64. */
export function encodeContext(context: GenerationContext): string {
  return gzipSync(JSON.stringify(context)).toString("base64");
}

/** Inverse of {@link encodeContext}; Zod-parsed, never cast. */
export function decodeContext(blob: string): GenerationContext {
  let raw: unknown;
  try {
    raw = JSON.parse(gunzipSync(Buffer.from(blob, "base64")).toString("utf8"));
  } catch (error) {
    throw new InvalidContextError(
      error instanceof Error ? error.message : String(error)
    );
  }
  const parsed = GenerationContextSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidContextError(parsed.error.message);
  return parsed.data;
}
