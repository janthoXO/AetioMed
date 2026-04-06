import type { Router } from "express";
import type { z } from "zod";
import type { EventBus } from "./event-bus.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExt = Extension<any, any>;

type InferConfig<E extends AnyExt> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  E extends Extension<infer S, any>
    ? S extends z.ZodTypeAny
      ? z.infer<S>
      : undefined
    : undefined;

export interface ExtensionSetupCtx<
  TSchema extends z.ZodTypeAny | undefined,
  TDeps extends readonly AnyExt[],
> {
  config: TSchema extends z.ZodTypeAny ? z.infer<TSchema> : undefined;
  bus: EventBus;
  router: Router;
  dep<D extends TDeps[number]>(ext: D): InferConfig<D>;
}

export interface Extension<
  TSchema extends z.ZodTypeAny | undefined = undefined,
  TDeps extends readonly AnyExt[] = readonly AnyExt[],
> {
  name: string;
  requiredFlags: string[];
  dependsOn: TDeps;
  envSchema: TSchema; // ← replacing configSchema
  setup(ctx: ExtensionSetupCtx<TSchema, TDeps>): Promise<void> | void;
}

export function defineExtension<
  TSchema extends z.ZodTypeAny | undefined = undefined,
  const TDeps extends readonly AnyExt[] = [],
>(def: {
  name: string;
  requiredFlags?: string[];
  dependsOn?: TDeps;
  envSchema?: TSchema;
  setup(ctx: ExtensionSetupCtx<TSchema, TDeps>): Promise<void> | void;
}): Extension<TSchema, TDeps> {
  return {
    name: def.name,
    requiredFlags: def.requiredFlags ?? [],
    dependsOn: (def.dependsOn ?? []) as unknown as TDeps,
    envSchema: def.envSchema as TSchema,
    setup: def.setup,
  };
}
