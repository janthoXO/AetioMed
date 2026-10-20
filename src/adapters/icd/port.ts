import z from "zod";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../persistence/db.js";
import { icdEntity } from "../persistence/schema.js";
import { ICDCodeSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { IcdUnavailableError, type IcdPort } from "@/core/diagnosis/icd.js";
import { IcdHttpError, type IcdClient } from "./client.js";

const CodeInfoSchema = z.object({ code: z.string(), stemId: z.string() });
const EntitySchema = z.object({ title: z.object({ "@value": z.string() }) });
const SearchSchema = z.object({
  destinationEntities: z.array(
    z.object({
      theCode: z.string().optional(),
      title: z.string(),
      matchingPVs: z
        .array(z.object({ propertyId: z.string(), label: z.string() }))
        .optional(),
    })
  ),
});

/**
 * `IcdPort` over the HTTP client. Entities are cache-aside in `icd_entity`:
 * an entity inside a pinned release never changes, so rows never expire.
 * Search stays live.
 */
export function createIcdPort(client: IcdClient, dbHandle: DbHandle): IcdPort {
  const { db } = dbHandle;
  const { release } = client;

  /** `undefined` on 404; anything but an abort becomes `IcdUnavailableError`. */
  async function get(
    path: string,
    language: string,
    init: { signal?: AbortSignal | undefined; query?: Record<string, string> }
  ): Promise<unknown> {
    try {
      return await client.get(path, language, init);
    } catch (error) {
      if (error instanceof IcdHttpError && error.status === 404)
        return undefined;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new IcdUnavailableError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Title of one code, stem or cluster (a cluster's title is its stem's).
   * `undefined`: not in the release, or a cluster ICD does not accept as is.
   */
  async function codeTitle(
    code: string,
    language: string,
    signal: AbortSignal | undefined
  ): Promise<string | undefined> {
    const info = await get(`/codeinfo/${encodeURIComponent(code)}`, language, {
      signal,
    });
    if (info === undefined) return undefined;
    // stemId: http://id.who.int/icd/release/11/<release>/mms/<id>[/unspecified]
    const { code: canonical, stemId } = CodeInfoSchema.parse(info);
    // codeinfo 404s an extension outside the stem's value sets, but silently
    // drops a second value on a single-value axis ("CA40.Z&XB22&XB25" comes
    // back as "CA40.Z&XB25"): a changed code is a cluster ICD rejected.
    if (canonical !== code) return undefined;
    const path = stemId.slice(stemId.indexOf("/mms/") + "/mms".length);
    const body = await get(path, language, { signal });
    if (body === undefined) return undefined;
    return EntitySchema.parse(body).title["@value"];
  }

  return {
    async entity(code, language, signal) {
      const key = and(
        eq(icdEntity.release, release),
        eq(icdEntity.code, code),
        eq(icdEntity.lang, language)
      );
      const cached = db.select().from(icdEntity).where(key).get();
      if (cached) return { code, title: cached.title };

      // A cluster's own title is only its stem's: "CA40.Z&XB22" would read
      // "Pneumonia, organism unspecified". Name the added codes after it.
      const [stem, ...added] = await Promise.all(
        [code, ...code.split(/[&/]/).slice(1)].map((c) =>
          codeTitle(c, language, signal)
        )
      );
      if (stem === undefined || added.includes(undefined)) return undefined;
      const title = added.length > 0 ? `${stem} (${added.join("; ")})` : stem;

      db.insert(icdEntity)
        .values({ release, code, lang: language, title })
        .onConflictDoNothing()
        .run();
      return { code, title };
    },

    async search(text, language, signal) {
      const body = await get("/search", language, {
        signal,
        query: {
          q: text,
          flatResults: "true",
          highlightingEnabled: "false",
          useFlexisearch: "false",
          // Off: "Pneumonia" hits CA40 Pneumonia, not codable leaf CA40.Z "…, organism unspecified".
          medicalCodingMode: "false",
        },
      });
      if (body === undefined) return [];
      return SearchSchema.parse(body).destinationEntities.flatMap((hit) => {
        const code = ICDCodeSchema.safeParse(hit.theCode);
        if (!code.success) return [];
        const synonyms = (hit.matchingPVs ?? [])
          .filter((pv) => pv.propertyId === "Synonym")
          .map((pv) => pv.label);
        return [{ code: code.data, title: hit.title, synonyms }];
      });
    },
  };
}
