import { z } from "zod";
import { Router } from "express";
import type { AnyExt } from "./extension.js";
import type { EventBus } from "./event-bus.js";

export interface LoaderOptions {
  extensions: AnyExt[];
  enabledFlags: Set<string>;
  bus: EventBus;
  apiRouter: Router;
}

function topoSort(extensions: AnyExt[]): AnyExt[] {
  const result: AnyExt[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byName = new Map(extensions.map((e) => [e.name, e]));

  function visit(ext: AnyExt) {
    if (visited.has(ext.name)) return;
    if (visiting.has(ext.name))
      throw new Error(`Circular dependency: ${ext.name}`);
    visiting.add(ext.name);
    for (const dep of ext.dependsOn) {
      if (!byName.has(dep.name))
        throw new Error(
          `"${ext.name}" depends on unregistered extension "${dep.name}"`
        );
      visit(byName.get(dep.name)!);
    }
    visiting.delete(ext.name);
    visited.add(ext.name);
    result.push(ext);
  }

  for (const ext of extensions) visit(ext);
  return result;
}

export async function loadExtensions(opts: LoaderOptions): Promise<void> {
  const { extensions, enabledFlags, bus, apiRouter } = opts;
  const sorted = topoSort(extensions);
  const resolvedConfigs = new Map<string, unknown>();
  const skipped = new Set<string>();

  for (const ext of sorted) {
    // 1. Feature-flag gate
    const missingFlags = ext.requiredFlags.filter((f) => !enabledFlags.has(f));
    if (missingFlags.length > 0) {
      console.log(
        `[loader] ⏭  "${ext.name}" — missing flags: [${missingFlags.join(", ")}]`
      );
      skipped.add(ext.name);
      continue;
    }

    // 2. Cascade-skip if a dependency was skipped
    const skippedDep = ext.dependsOn.find((d: AnyExt) => skipped.has(d.name));
    if (skippedDep) {
      console.log(
        `[loader] ⏭  "${ext.name}" — dep "${skippedDep.name}" was skipped`
      );
      skipped.add(ext.name);
      continue;
    }

    // 3. Parse this extension's slice of process.env via its Zod schema
    let config: unknown = undefined;
    if (ext.envSchema) {
      const result = ext.envSchema.safeParse(process.env);
      if (!result.success) {
        // Collect all field errors in one throw so operators can fix everything at once
        const problems = result.error.errors
          .map((e: z.ZodIssue) => `  ${e.path.join(".")}: ${e.message}`)
          .join("\n");
        throw new Error(
          `Env validation failed for extension "${ext.name}":\n${problems}`
        );
      }
      config = result.data;
    }
    resolvedConfigs.set(ext.name, config);

    // 4. Use the main apiRouter directly without a prefix prefix as requested
    const router = Router();
    apiRouter.use("/", router);

    // 5. Build context + call setup
    await ext.setup({
      config,
      bus,
      router,
      dep(depExt: AnyExt) {
        if (!resolvedConfigs.has(depExt.name))
          throw new Error(
            `"${ext.name}" accessed dep "${depExt.name}" before it resolved`
          );
        return resolvedConfigs.get(depExt.name);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    console.log(`[loader] ✓  "${ext.name}"`);
  }
}
