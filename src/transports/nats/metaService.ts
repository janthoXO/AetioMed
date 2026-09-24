// NATS counterpart of the REST read-only endpoints (`/api/diagnosis`,
// `/procedures`, `/features`, `/allowedLlms`, `/graph`), on `@nats-io/services`
// (discovery via `$SRV.PING|INFO|STATS`, per-endpoint stats, `respondError`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NatsConnection } from "@nats-io/transport-node";
import { Svcm, type Service, type ServiceMsg } from "@nats-io/services";
import type { ReadModel } from "@/core/readModel.js";
import {
  CATALOG_DIAGNOSIS_SUBJECT,
  CATALOG_PROCEDURES_SUBJECT,
  META_FEATURES_SUBJECT,
  META_ALLOWED_LLMS_SUBJECT,
  META_GRAPH_SUBJECT,
} from "./subjects.js";

const FALLBACK_VERSION = "0.0.0";

/**
 * Read `version` from repo `package.json`. `src/` and `dist/` are both three
 * levels below root, so `../../../package.json` works either way. Dockerfile
 * `runner` stage copies it. Falls back to {@link FALLBACK_VERSION}.
 */
function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(
      new URL("../../../package.json", import.meta.url)
    );
    const raw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string"
      ? parsed.version
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/** One REST/NATS parity endpoint. */
interface MetaEndpoint {
  name: string;
  subject: string;
  call: () => unknown;
}

function endpointsFor(readModel: ReadModel): MetaEndpoint[] {
  return [
    {
      name: "diagnosis",
      subject: CATALOG_DIAGNOSIS_SUBJECT,
      call: () => readModel.diagnoses(),
    },
    {
      name: "procedures",
      subject: CATALOG_PROCEDURES_SUBJECT,
      call: () => readModel.procedures(),
    },
    {
      name: "features",
      subject: META_FEATURES_SUBJECT,
      call: () => readModel.features(),
    },
    {
      name: "allowedLlms",
      subject: META_ALLOWED_LLMS_SUBJECT,
      call: () => readModel.allowedLlms(),
    },
    {
      name: "graph",
      subject: META_GRAPH_SUBJECT,
      call: () => readModel.graph(),
    },
  ];
}

function respond(msg: ServiceMsg, value: unknown): void {
  msg.respond(JSON.stringify(value ?? null));
}

/**
 * Start `aetiomed` micro service with the five read-only endpoints. Default
 * queue group: replicas answer identically, any one may respond.
 *
 * Returns stop function.
 */
export async function startMetaService(opts: {
  nc: NatsConnection;
  readModel: ReadModel;
}): Promise<() => Promise<void>> {
  const { nc, readModel } = opts;
  const svcm = new Svcm(nc);

  const service: Service = await svcm.add({
    name: "aetiomed",
    version: readPackageVersion(),
    description: "AetioMed catalogue, feature and graph-structure reads",
  });

  for (const endpoint of endpointsFor(readModel)) {
    service.addEndpoint(endpoint.name, {
      subject: endpoint.subject,
      handler: (err, msg) => {
        if (err) return;
        Promise.resolve(endpoint.call())
          .then((value) => respond(msg, value))
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[NATS] meta service endpoint ${endpoint.name} failed`,
              error
            );
            msg.respondError(500, message);
          });
      },
    });
  }

  return async () => {
    await service.stop();
  };
}
