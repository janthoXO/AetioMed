import type z from "zod";
import type { AnamnesisCategory } from "../models/Anamnesis.js";
import type { Procedure, ProcedureName } from "../models/Procedure.js";
import type { Diagnosis, ICDCode } from "../models/Diagnosis.js";
import type { ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Synthetic category bucket for procedure names with no `"Category: Name"`
 * prefix — kept separate from the real categories so it can be handled
 * specially (e.g. always offered, never itself a filterable choice).
 */
export const UNCATEGORIZED_CATEGORY = "General";

/**
 * How the approved procedure list is presented to (and expected back from) a
 * blinded pick step:
 *   - "freeform": no approved list configured — the LLM invents freely.
 *   - "flat": an approved list exists but none of its entries carry a
 *     `"Category: Name"` prefix — shown/returned as a plain list of names.
 *   - "grouped": an approved list exists with real categories — shown/returned
 *     grouped by category so a small model only reasons over one category's
 *     worth of names at a time.
 */
export type ProcedurePickMode =
  | { kind: "freeform" }
  | { kind: "flat"; names: ProcedureName[] }
  | { kind: "grouped"; grouped: Map<string, ProcedureName[]> };

/** `undefined` list ⇒ freeform: no catalogue configured, names may be invented. */
export interface ProcedureCatalog {
  list(): ProcedureName[] | undefined;
  /** Real categories, first-seen order, excluding the synthetic bucket. */
  categories(): string[];
  /** Bare names grouped by category, including the synthetic bucket. */
  grouped(): Map<string, ProcedureName[]>;
  /** The full candidate set. */
  candidates(): ProcedureCandidates;
  /** Candidates narrowed to these categories, plus the uncategorized bucket. */
  scope(categories: string[]): ProcedureCandidates;
}

export interface ProcedureCandidates {
  /**
   * Discriminated view, for callers that must build their own grammar over the
   * same candidate set (the bridge's full `{name, relevance, result}` schema).
   */
  readonly mode: ProcedurePickMode;
  /** Remove already-ordered procedures (full names). Returns a new set. */
  exclude(ordered: ProcedureName[]): ProcedureCandidates;
  isEmpty(): boolean;
  /** Real categories still present in this candidate set. */
  categories(): string[];
  /** Zod schema constraining a pick to this set — the grammar sent to the provider. */
  grammar(): z.ZodTypeAny;
  /** Name-agnostic schema for the prompt's "Output format" example. */
  promptSchema(): z.ZodTypeAny;
  /**
   * The complete "Approved procedure list" prompt section, or `undefined` in
   * freeform mode. Returns a section, not a bare list, because the heading text
   * is mode-dependent and the mode is the catalogue's business.
   */
  render(): string | undefined;
  /** One line per real category with a size hint and sample names. */
  categoryMenu(only?: string[]): string;
  /** Turn a model's raw pick back into full "Category: Name" values. */
  assemble(pick: unknown): Procedure[];
}

export interface AnamnesisCatalog {
  list(): AnamnesisCategory[] | undefined;
}

/**
 * Trace node label translations, as consumed by `utils/nodeWrapper.ts`
 * (synchronous per-label lookup on the trace hot path) and
 * `02graphs/caseGraph.ts` (batch warm-up before generation starts).
 */
export interface LabelCatalog {
  /** Synchronous lookup of a label's cached translation, or `undefined` if uncached. */
  translate(label: string, lang: ForeignLanguage): string | undefined;
  /**
   * Translate every requested label not already cached, in one deduped
   * batch, persisting the results. Never throws — a label that cannot be
   * translated is simply absent from the result.
   */
  ensureTranslated(
    labels: string[],
    lang: ForeignLanguage,
    generate: (
      missing: string[],
      lang: ForeignLanguage,
      ctx?: RequestContext
    ) => Promise<Record<string, string>>,
    ctx?: RequestContext
  ): Promise<Record<string, string>>;
}

/**
 * Predefined ICD-11 diagnoses and their translations, as consumed by
 * `02graphs/01case-translation-to-english/tools.ts`, `catalog/diagnosis/repo.ts`'s
 * other consumers and the `/diagnosis` REST route.
 */
export interface DiagnosisCatalog {
  byIcd(icd: ICDCode): Diagnosis | undefined;
  all(): Diagnosis[];
  /** Reverse lookup: a translated diagnosis name back to its English form. */
  toEnglish(diagnosis: string, lang: ForeignLanguage): string | undefined;
  saveTranslations(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): void;
}
