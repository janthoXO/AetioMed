import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  createGrpcReferralLetterRenderer,
  probeReferralGrpc,
  REFERRAL_PROTO,
} from "./grpc.js";

const requests: unknown[] = [];
let server: grpc.Server;
let address: string;

// A fake AetioReferral over the real contract: proves the wire mapping.
beforeAll(async () => {
  const pkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(REFERRAL_PROTO, { enums: String, defaults: true })
  ) as unknown as {
    aetioreferral: {
      v1: { ReferralService: { service: grpc.ServiceDefinition } };
    };
  };
  server = new grpc.Server();
  server.addService(pkg.aetioreferral.v1.ReferralService.service, {
    RenderLetter: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      cb: grpc.sendUnaryData<unknown>
    ) => {
      requests.push(call.request);
      cb(null, { pdf: Buffer.from("%PDF"), seed: 7 });
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, p) => (error ? reject(error) : resolve(p))
    )
  );
  address = `127.0.0.1:${port}`;
});

afterAll(() => server.forceShutdown());

describe("referral letter over gRPC", () => {
  it("probes, then renders with no patient block and drafted fields only", async () => {
    await probeReferralGrpc(address);
    const render = createGrpcReferralLetterRenderer(address);

    const pdf = await render(
      {
        sender_name: null,
        recipient_specialty: "Kardiologie",
        reason: "Abklärung Thoraxschmerz",
        urgent: true,
        suspected_diagnosis: "V.a. ACS",
        history: null,
        findings: "EKG: ST-Hebung",
      },
      "de"
    );

    expect(new TextDecoder().decode(pdf)).toBe("%PDF");
    const { letter } = requests[0] as { letter: Record<string, unknown> };
    expect(letter).toMatchObject({
      language: "de",
      recipientSpecialty: "Kardiologie",
      urgent: true,
      noPatient: true,
      suspectedDiagnosis: "V.a. ACS",
      findings: "EKG: ST-Hebung",
    });
    expect(letter["sender"]).toMatchObject({ identifiers: {} });
    expect(letter["history"]).toBeUndefined(); // null stays unset, not ""
  });
});
