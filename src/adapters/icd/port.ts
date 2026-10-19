import z from "zod";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../persistence/db.js";
import { icdEntity } from "../persistence/schema.js";
import { ICDCodeSchema } from "@/core/graph/shared/domain/Diagnosis.js";
import { IcdUnavailableError, type IcdPort } from "@/core/diagnosis/icd.js";
import { IcdHttpError, type IcdClient } from "./client.js";

const CodeInfoSchema = z.object({ stemId: z.string() });
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

  return {
    async entity(code, language, signal) {
      const key = and(
        eq(icdEntity.release, release),
        eq(icdEntity.code, code),
        eq(icdEntity.lang, language)
      );
      const cached = db.select().from(icdEntity).where(key).get();
      if (cached) return { code, title: cached.title };

      const info = await get(`/codeinfo/${code}`, language, { signal });
      if (info === undefined) return undefined;
      // stemId: http://id.who.int/icd/release/11/<release>/mms/<id>[/unspecified]
      const { stemId } = CodeInfoSchema.parse(info);
      const path = stemId.slice(stemId.indexOf("/mms/") + "/mms".length);
      const body = await get(path, language, { signal });
      if (body === undefined) return undefined;
      const title = EntitySchema.parse(body).title["@value"];

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
