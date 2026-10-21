import type z from "zod";
import type { AnamnesisCategory } from "@/core/graph/shared/domain/Anamnesis.js";
import type {
  ProcedureRef,
  ProcedureTree,
} from "@/core/graph/shared/domain/ProcedureTree.js";
import type { ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import type { RequestContext } from "../utils/context.js";

/** Catalogue shape: procedures under categories of any depth. */
export type ProcedureCatalogTree = ProcedureTree<{ name: string }>;

/** `undefined` tree ⇒ freeform: no catalogue configured, names may be invented. */
export interface ProcedureCatalog {
  tree(): ProcedureCatalogTree | undefined;
  /** The full candidate set. */
  candidates(): ProcedureCandidates;
  /** Cached translation of one catalogue node (category or procedure), keyed by `nodeKey(path)`. */
  translation(nodeKey: string, lang: ForeignLanguage): string | undefined;
  /** Persist `nodeKey -> translated name` for `lang`. */
  saveTranslations(
    byNodeKey: Record<string, string>,
    lang: ForeignLanguage
  ): void;
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
  /** Cached translation of an English category name into `lang`. */
  fromEnglish(
    category: AnamnesisCategory,
    lang: ForeignLanguage
  ): AnamnesisCategory | undefined;
  /** Persist `english -> translated` category names for `lang`. */
  saveTranslations(
    englishToTarget: Record<AnamnesisCategory, AnamnesisCategory>,
    lang: ForeignLanguage
  ): void;
}

/**
 * Outline section-title translations (`OUTLINE_SECTIONS`), keyed by the
 * English title. Curated YAML always wins; a runtime fill is persisted and
 * never regenerated.
 */
export interface OutlineHeadingCatalog {
  fromEnglish(title: string, lang: ForeignLanguage): string | undefined;
  /** Persist `english -> translated` titles for `lang`. */
  saveTranslations(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): void;
}

/**
 * Trace node label translations, as consumed by `utils/nodeWrapper.ts`
 * (synchronous per-label lookup on the trace hot path) and
 * `assemble.ts` (batch warm-up before generation starts).
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
 * Translation of diagnosis names to English when no ICD is configured
 * (`core/diagnosis/resolve.ts`).
 */
export interface DiagnosisCatalog {
  /** Reverse lookup: a translated diagnosis name back to its English form. */
  toEnglish(diagnosis: string, lang: ForeignLanguage): string | undefined;
  saveTranslations(
    englishToTarget: Record<string, string>,
    lang: ForeignLanguage
  ): void;
}
