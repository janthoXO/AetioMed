import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

/**
 * A provider service's contract, copied from its repo into repo-root `proto/`
 * (three directories up in both `src/` and `dist/`). `.github/workflows/
 * contracts.yml` opens a PR when the provider's own copy changes.
 */
export function contractPath(relative: string): string {
  return fileURLToPath(new URL(`../../../proto/${relative}`, import.meta.url));
}

type UnaryMethod = (
  request: object,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void
) => grpc.ClientUnaryCall;

export type GrpcService = {
  /** One unary call; an aborted `signal` cancels it. Response unparsed: callers zod-parse it. */
  call(method: string, request: object, signal?: AbortSignal): Promise<unknown>;
  /** Resolves once connected; rejects after the deadline. A startup probe, no RPC. */
  ready(): Promise<void>;
  close(): void;
};

/**
 * Plaintext client for `service` (e.g. `aetioecg.v1.EcgService`) in `proto`.
 * Provider services have no TLS: private network only. Proto3 JSON field
 * names (camelCase), enums as names.
 */
export function createGrpcService(
  proto: string,
  service: string,
  address: string,
  deadlineMs: number
): GrpcService {
  const definition = protoLoader.loadSync(proto, {
    enums: String,
    longs: Number,
    defaults: true,
  });
  const Client = service
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      grpc.loadPackageDefinition(definition)
    ) as grpc.ServiceClientConstructor;
  const client = new Client(address, grpc.credentials.createInsecure());

  return {
    call: (method, request, signal) =>
      new Promise((resolve, reject) => {
        const pending = (client[method] as UnaryMethod).call(
          client,
          request,
          { deadline: Date.now() + deadlineMs },
          (error, response) => (error ? reject(error) : resolve(response))
        );
        signal?.addEventListener("abort", () => pending.cancel(), {
          once: true,
        });
      }),
    ready: () =>
      new Promise((resolve, reject) =>
        client.waitForReady(Date.now() + deadlineMs, (error) =>
          error ? reject(error) : resolve()
        )
      ),
    close: () => client.close(),
  };
}
