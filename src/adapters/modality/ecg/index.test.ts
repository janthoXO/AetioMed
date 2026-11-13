import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ECG_PROTO } from "./grpc.js";
import { ecgModule } from "./index.js";

const SVG = "<svg/>";
const requests: unknown[] = [];
let server: grpc.Server;
let env: { ECG_GRPC_ADDRESS: string };

// A fake AetioECG over the real contract: proves the wire mapping, not just the provider.
beforeAll(async () => {
  const pkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(ECG_PROTO, { enums: String, defaults: true })
  ) as unknown as {
    aetioecg: { v1: { EcgService: { service: grpc.ServiceDefinition } } };
  };
  server = new grpc.Server();
  server.addService(pkg.aetioecg.v1.EcgService.service, {
    ListOptions: (_call: unknown, cb: grpc.sendUnaryData<unknown>) =>
      cb(null, {
        source: "fake",
        statements: [{ code: "AFIB", description: "atrial fibrillation" }],
      }),
    GetEcg: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      cb: grpc.sendUnaryData<unknown>
    ) => {
      requests.push(call.request);
      cb(null, { mimeType: "image/svg+xml", image: Buffer.from(SVG) });
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, p) => (error ? reject(error) : resolve(p))
    )
  );
  env = { ECG_GRPC_ADDRESS: `127.0.0.1:${port}` };
});

afterAll(() => server.forceShutdown());

describe("ecgModule", () => {
  it("probes the codes into the grammar and renders an SVG over gRPC", async () => {
    const options = await ecgModule.probe!(env);
    const provider = ecgModule.create(env, {} as never, "ECG.", options);

    expect(provider.description).toContain("AFIB (atrial fibrillation)");
    expect(
      provider.inputSchema.safeParse({
        statements: ["STEMI"],
        sex: null,
        age: null,
      }).success
    ).toBe(false);

    const [svg] = await provider.render(
      [
        {
          input: { statements: ["AFIB"], sex: "female", age: 67 },
          alt: "AF",
        },
      ],
      {}
    );
    expect(new TextDecoder().decode(svg)).toBe(SVG);
    expect(requests[0]).toMatchObject({
      statements: ["AFIB"],
      sex: "SEX_FEMALE",
      age: 67,
    });
  });
});
