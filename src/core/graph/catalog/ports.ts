import type z from "zod";
import type { AnamnesisCategory } from "../models/Anamnesis.js";
import type { ProcedureRef, ProcedureTree } from "../models/ProcedureTree.js";
import type { Diagnosis, ICDCode } from "../models/Diagnosis.js";
import type { ForeignLanguage } from "../models/Language.js";
import type { RequestContext } from "../utils/context.js";

/** Catalogue shape: procedures under categories of any depth. */
export type ProcedureCatalogTree = ProcedureTree<{ name: string }>;

/** `undefined` tree ⇒ freeform: no catalogue configured, names may be invented. */
export interface ProcedureCatalog {
  tree(): ProcedureCatalogTree | undefined;
  /** The full candidate set. */
  candidates(): ProcedureCandidates;
}

export interface ProcedureCandidates {
  /** Remove already-ordered procedures. Returns a new set. */
  exclude(ordered: ProcedureRef[]): ProcedureCandidates;
  isEmpty(): boolean;
  /** Zod schema constraining a pick to this set — the grammar sent to the provider. */
  grammar(): z.ZodTypeAny;
  /** Name-agnostic schema for the prompt's "Output format" example. */
  promptSchema(): z.ZodTypeAny;
  /** The "Approved procedure catalogue" prompt section, or `undefined` in freeform mode. */
  render(): string | undefined;
  /** Turn a model's raw pick back into procedure refs; anything outside the set is dropped. */
  assemble(pick: unknown): ProcedureRef[];
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
