import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import z from "zod";

/**
 * Copy of AetioECG's contract (its `proto/aetioecg/v1/ecg.proto` is the source
 * of truth). Repo-root `proto/`, four directories up in both `src/` and `dist/`.
 */
export const ECG_PROTO = fileURLToPath(
  new URL("../../../../proto/aetioecg/v1/ecg.proto", import.meta.url)
);

/** `GetEcg` reads the record from PTB-XL, possibly from PhysioNet on demand. */
const DEADLINE_MS = 60_000;

const EcgOptionsSchema = z.object({
  source: z.string(),
  statements: z
    .array(z.object({ code: z.string().min(1), description: z.string() }))
    .min(1),
});
export type EcgOptions = z.infer<typeof EcgOptionsSchema>;

const EcgSchema = z.object({
  mimeType: z.literal("image/svg+xml"),
  image: z.instanceof(Uint8Array),
});

export type EcgRequest = {
  statements: string[];
  sex: "male" | "female" | null;
  age: number | null;
};

export interface EcgClient {
  listOptions(): Promise<EcgOptions>;
  /** One 12-lead ECG as SVG bytes. */
  getEcg(
    request: EcgRequest,
    signal?: AbortSignal
  ): Promise<Uint8Array<ArrayBuffer>>;
  close(): void;
}

type UnaryMethod = (
  request: object,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void
) => grpc.ClientUnaryCall;

/** `aetioecg.v1.EcgService` over plaintext gRPC (AetioECG has no TLS: private network only). Responses parsed, never cast. */
export function createGrpcEcgClient(address: string): EcgClient {
  const definition = protoLoader.loadSync(ECG_PROTO, {
    enums: String,
    longs: Number,
    defaults: true,
  });
  const { EcgService } = (
    grpc.loadPackageDefinition(definition) as unknown as {
      aetioecg: { v1: { EcgService: grpc.ServiceClientConstructor } };
    }
  ).aetioecg.v1;
  const client = new EcgService(address, grpc.credentials.createInsecure());

  const call = (method: string, request: object, signal?: AbortSignal) =>
    new Promise<unknown>((resolve, reject) => {
      const pending = (client[method] as UnaryMethod).call(
        client,
        request,
        { deadline: Date.now() + DEADLINE_MS },
        (error, response) => (error ? reject(error) : resolve(response))
      );
      signal?.addEventListener("abort", () => pending.cancel(), {
        once: true,
      });
    });

  return {
    listOptions: async () =>
      EcgOptionsSchema.parse(await call("ListOptions", {})),
    getEcg: async ({ statements, sex, age }, signal) => {
      const ecg = EcgSchema.parse(
        await call(
          "GetEcg",
          {
            statements,
            sex: sex ? `SEX_${sex.toUpperCase()}` : "SEX_UNSPECIFIED",
            ...(age !== null && { age }),
          },
          signal
        )
      );
      return new Uint8Array(ecg.image); // copy: a Buffer may share a pooled ArrayBuffer
    },
    close: () => client.close(),
  };
}
