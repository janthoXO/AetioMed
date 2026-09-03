import type { AnamnesisCategory } from "../models/Anamnesis.js";
import { getEffectiveCategoryList } from "../03repo/anamnesis.repo.js";
import type { AnamnesisCatalog } from "./ports.js";

class StaticAnamnesisCatalog implements AnamnesisCatalog {
  constructor(
    private readonly effectiveList: AnamnesisCategory[] | undefined
  ) {}

  list(): AnamnesisCategory[] | undefined {
    return this.effectiveList;
  }
}

/** Reads the effective category list from `03repo/anamnesis.repo.ts` once, at construction. */
export class YamlAnamnesisCatalog extends StaticAnamnesisCatalog {
  constructor() {
    super(getEffectiveCategoryList());
  }
}

/** Test/injection adapter over a plain string array (or `undefined` for freeform). */
export class InMemoryAnamnesisCatalog extends StaticAnamnesisCatalog {
  constructor(categories?: AnamnesisCategory[]) {
    super(categories);
  }
}
