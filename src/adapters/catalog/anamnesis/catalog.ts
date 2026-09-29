import type { AnamnesisCategory } from "@/core/graph/shared/domain/Anamnesis.js";
import type { ForeignLanguage } from "@/core/graph/shared/domain/Language.js";
import type { AnamnesisRepo } from "./repo.js";
import type { AnamnesisCatalog } from "@/core/graph/catalog/ports.js";

abstract class StaticAnamnesisCatalog implements AnamnesisCatalog {
  constructor(
    private readonly effectiveList: AnamnesisCategory[] | undefined
  ) {}

  list(): AnamnesisCategory[] | undefined {
    return this.effectiveList;
  }

  abstract fromEnglish(
    category: AnamnesisCategory,
    lang: ForeignLanguage
  ): AnamnesisCategory | undefined;

  abstract saveTranslations(
    englishToTarget: Record<AnamnesisCategory, AnamnesisCategory>,
    lang: ForeignLanguage
  ): void;
}

/** Reads the effective category list from an `AnamnesisRepo` once, at construction. */
export class YamlAnamnesisCatalog extends StaticAnamnesisCatalog {
  constructor(private readonly repo: AnamnesisRepo) {
    super(repo.getEffectiveCategoryList());
  }

  fromEnglish(
    category: AnamnesisCategory,
    lang: ForeignLanguage
  ): AnamnesisCategory | undefined {
    return this.repo.getAnamnesisCategoryTranslationFromEnglish(category, lang);
  }

  saveTranslations(
    englishToTarget: Record<AnamnesisCategory, AnamnesisCategory>,
    lang: ForeignLanguage
  ): void {
    this.repo.saveAnamnesisCategoryTranslations(englishToTarget, lang);
  }
}

/** Test/injection adapter over a plain string array (or `undefined` for freeform). */
export class InMemoryAnamnesisCatalog extends StaticAnamnesisCatalog {
  private readonly translations = new Map<
    ForeignLanguage,
    Map<AnamnesisCategory, AnamnesisCategory>
  >();

  constructor(categories?: AnamnesisCategory[]) {
    super(categories);
  }

  fromEnglish(
    category: AnamnesisCategory,
    lang: ForeignLanguage
  ): AnamnesisCategory | undefined {
    return this.translations.get(lang)?.get(category);
  }

  saveTranslations(
    englishToTarget: Record<AnamnesisCategory, AnamnesisCategory>,
    lang: ForeignLanguage
  ): void {
    let map = this.translations.get(lang);
    if (!map) {
      map = new Map();
      this.translations.set(lang, map);
    }
    for (const [english, translated] of Object.entries(englishToTarget)) {
      map.set(english, translated);
    }
  }
}
