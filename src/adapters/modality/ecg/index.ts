import z from "zod";
import {
  defineModalityProvider,
  type ModalityProvider,
} from "@/core/graph/shared/modality/ports.js";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { ModalityProviderModule } from "../resolve.js";
import {
  createGrpcEcgClient,
  type EcgClient,
  type EcgOptions,
} from "./grpc.js";

const EnvSchema = z.object({
  /** AetioECG's gRPC server, `host:port`, e.g. localhost:50051. */
  ECG_GRPC_ADDRESS: z.string().min(1),
});

/**
 * Real 12-lead ECGs (PTB-XL) for the SCP-ECG statements the planner picks.
 * The codes come from `ListOptions` at startup, so the grammar only admits
 * what the server can serve. The SVG holds no text to translate.
 */
export function ecgProvider(
  client: EcgClient,
  options: EcgOptions,
  description: string
): ModalityProvider<unknown> {
  const codes = options.statements.map((s) => s.code);
  return defineModalityProvider({
    id: "ecg",
    mime: "image/svg+xml",
    description: `${description} Statement codes: ${options.statements
      .map((s) => `${s.code} (${s.description})`)
      .join(", ")}.`,
    inputSchema: z.object({
      statements: z
        .array(z.enum(codes))
        .min(1)
        .describe(
          'SCP-ECG statement codes the ECG must show, e.g. ["AFIB"] or ["IMI", "SR"]; ["NORM"] for a normal ECG'
        ),
      sex: z
        .enum(["male", "female"])
        .nullable()
        .describe("The patient's sex; null if unknown"),
      age: z
        .number()
        .int()
        .min(0)
        .max(120)
        .nullable()
        .describe("The patient's age in years; null if unknown"),
    }),
    render: (batch, context) =>
      Promise.all(
        batch.map(({ input }) => client.getEcg(input, context.signal))
      ),
  });
}

/** 12-lead ECG images for procedure results, served by AetioECG over gRPC. */
export const ecgModule: ModalityProviderModule<typeof EnvSchema, EcgOptions> = {
  id: "ecg",
  fields: {
    procedureResult: {
      mode: "optional",
      description:
        "A real recorded 12-lead ECG as an image, showing the SCP-ECG statements in its input. Only for an ECG procedure; its alt states the ECG findings (rhythm, rate, axis, intervals, ST/T changes) matching those statements.",
    },
  },
  env: EnvSchema,
  probe: async (env) => {
    const client = createGrpcEcgClient(env.ECG_GRPC_ADDRESS);
    try {
      return await retry(() => client.listOptions(), 2, 1000);
    } finally {
      client.close();
    }
  },
  create: (env, _runtime, description, options) =>
    ecgProvider(
      createGrpcEcgClient(env.ECG_GRPC_ADDRESS),
      options,
      description
    ),
};
