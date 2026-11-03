import type { z } from "zod";
import type { GraphRuntime } from "@/core/graph/runtime.js";
import type { ModalityProvider } from "@/core/graph/shared/modality/ports.js";
import type {
  ModalityField,
  ModalityRegistries,
} from "@/core/graph/shared/modality/registry.js";

/**
 * A pluggable modality provider: everything it needs (env, startup probe,
 * prompts, I/O) lives in its own module under `adapters/modality/<id>/`.
 *
 * `fields` lists every field it can serve. `always` = registered whenever
 * the server runs; `optional` = registered only when `MODALITY_PROVIDERS`
 * lists `<FIELD>_<ID>` (e.g. `CHIEF_COMPLAINT_REFERRAL_LETTER`). A field it
 * does not list can never use it.
 */
export interface ModalityProviderModule<E extends z.ZodObject = z.ZodObject> {
  readonly id: string;
  readonly fields: Partial<
    Record<
      ModalityField,
      {
        mode: "always" | "optional";
        /** Shown to that field's planner. */ description: string;
      }
    >
  >;
  /** Its own env vars. Parsed (so required) only when the provider is active in some field. */
  readonly env: E;
  /** Startup check, run only when active. Throwing fails startup. */
  probe?(env: z.infer<E>): Promise<void>;
  /** Called once per active field, with that field's description. */
  create(
    env: z.infer<E>,
    runtime: GraphRuntime,
    description: string
  ): ModalityProvider<unknown>;
}

/** `chiefComplaint` + `referral_letter` → `CHIEF_COMPLAINT_REFERRAL_LETTER`. */
export function modalityToken(field: ModalityField, id: string): string {
  return `${field.replace(/[A-Z]/g, (c) => `_${c}`)}_${id}`.toUpperCase();
}

/** `""` counts as unset, as in `envGroup`: compose passes every var, empty when absent. */
function pickEnv(schema: z.ZodObject, env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.keys(schema.shape).map((k) => [k, env[k] || undefined])
  );
}

/**
 * Resolves `MODALITY_PROVIDERS` against `modules`: an unknown token, a
 * missing env var of an active provider, or a failed probe throws (startup
 * error). An inactive provider with any of its env vars set only warns.
 * Returns the per-field providers to add once the runtime exists.
 */
export async function resolveModalityProviders(
  modules: ModalityProviderModule[],
  env: NodeJS.ProcessEnv
): Promise<(runtime: GraphRuntime) => Partial<ModalityRegistries>> {
  const requested = new Set(
    (env.MODALITY_PROVIDERS ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  );
  const known = modules.flatMap((m) =>
    Object.entries(m.fields)
      .filter(([, f]) => f.mode === "optional")
      .map(([field]) => modalityToken(field as ModalityField, m.id))
  );
  const unknown = [...requested].filter((t) => !known.includes(t));
  if (unknown.length > 0) {
    throw new Error(
      `MODALITY_PROVIDERS: unknown ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}`
    );
  }

  const active = modules.flatMap((module) => {
    const fields = (
      Object.entries(module.fields) as [
        ModalityField,
        { mode: string; description: string },
      ][]
    ).filter(
      ([field, f]) =>
        f.mode === "always" || requested.has(modalityToken(field, module.id))
    );
    const raw = pickEnv(module.env, env);
    if (fields.length === 0) {
      const set = Object.keys(raw).filter((k) => raw[k] !== undefined);
      if (set.length > 0) {
        console.warn(
          `[modality] ${set.join(", ")} set, but provider "${module.id}" is not enabled for any field — ignored. Enable via MODALITY_PROVIDERS=${Object.keys(
            module.fields
          )
            .map((f) => modalityToken(f as ModalityField, module.id))
            .join("|")}`
        );
      }
      return [];
    }
    const parsed = module.env.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `[modality] provider "${module.id}" is enabled but its env is invalid: ${parsed.error.message}`
      );
    }
    return [{ module, fields, config: parsed.data }];
  });

  await Promise.all(
    active.map(async ({ module, config }) => {
      try {
        await module.probe?.(config);
      } catch (error) {
        throw new Error(
          `[modality] startup probe of "${module.id}" failed: ${(error as Error).message}`,
          { cause: error }
        );
      }
    })
  );
  for (const { module, fields } of active) {
    console.log(
      `[modality] ${module.id}: ${fields.map(([f]) => f).join(", ")}`
    );
  }

  return (runtime) => {
    const registries: Partial<ModalityRegistries> = {};
    for (const { module, fields, config } of active) {
      for (const [field, { description }] of fields) {
        (registries[field] ??= []).push(
          module.create(config, runtime, description)
        );
      }
    }
    return registries;
  };
}
