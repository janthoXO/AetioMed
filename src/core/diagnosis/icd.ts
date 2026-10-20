import type { ICDCode } from "@/core/graph/shared/domain/Diagnosis.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import { AppError } from "@/core/graph/errors/AppError.js";

/** One ICD-11 MMS entity, titled in one language. */
export type IcdEntity = { code: ICDCode; title: string };

/** A search hit: the entity plus the synonyms the query matched (ICD's `matchingPVs`). */
export type IcdSearchHit = IcdEntity & { synonyms: string[] };

/**
 * WHO ICD-11 API for one pinned release (#236). Adapters: HTTP with a SQLite
 * entity cache (`adapters/icd/`), in-memory for tests.
 */
export interface IcdPort {
  /**
   * `undefined`: the code is not in the release, or a cluster ICD rejects.
   * A cluster's title is its stem's, the added codes' titles in parentheses.
   */
  entity(
    code: ICDCode,
    language: Language,
    signal?: AbortSignal
  ): Promise<IcdEntity | undefined>;
  /** Hits in ICD's order; codeless (block) hits dropped, indexed clusters kept. */
  search(
    text: string,
    language: Language,
    signal?: AbortSignal
  ): Promise<IcdSearchHit[]>;
}

/** ICD configured but not answering (down, 5xx, timeout). */
export class IcdUnavailableError extends AppError {
  constructor(details?: string) {
    super("The ICD API is unavailable", "ICD_UNAVAILABLE", 503, details);
  }
}
