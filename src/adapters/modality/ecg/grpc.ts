import z from "zod";
import { contractPath, createGrpcService } from "../grpc.js";

/** Copy of AetioECG's contract (its `proto/aetioecg/v1/ecg.proto` is the source of truth). */
export const ECG_PROTO = contractPath("aetioecg/v1/ecg.proto");

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

/** `aetioecg.v1.EcgService` over plaintext gRPC. Responses parsed, never cast. */
export function createGrpcEcgClient(address: string): EcgClient {
  const { call, close } = createGrpcService(
    ECG_PROTO,
    "aetioecg.v1.EcgService",
    address,
    DEADLINE_MS
  );

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
    close,
  };
}
