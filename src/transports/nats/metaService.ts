// Request/reply parity (#144): the NATS-only counterpart of the REST
// read-only endpoints (`GET /api/diagnosis`, `/procedures`, `/features`,
// `/allowedLlms`, `/graph`), built on `@nats-io/services`, the NATS "micro"
// framework.
//
// Decision (design doc §D2, docs/issues/17-transport-parity.md): use `@nats-io/services` rather than five bare `nc.subscribe`
// request/reply handlers. It gives a NATS-only client discovery
// (`$SRV.PING|INFO|STATS`), per-endpoint stats, and an error-header
// mechanism (`msg.respondError`) for free — close to the literal definition
// of "a NATS-only client has every feature": those clients would otherwise
// have no way to even discover this service exists. The cost is one small
// dependency from the same `@nats-io/*` org as the ones already in
// `package.json`.
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
 * Read the repo's own `package.json` `version` field at runtime, relative to
 * this module's own location — `src/transports/nats/` and
 * `dist/transports/nats/` are both three levels below the repo root, so
 * `../../../package.json` resolves correctly either way.
 *
 * The `Dockerfile`'s `runner` stage copies `package.json` for this. Falls
 * back to {@link FALLBACK_VERSION} if the file is unreadable or unparsable.
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

/** One row of the REST/NATS parity table (§D2). */
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
 * Start the `aetiomed` micro service and register the five read-only
 * endpoints above. Every replica answers reads identically, so this uses the
 * framework's default queue group rather than opting out of it — whichever
 * replica gets the request answers it.
 *
 * Returns a function that stops the service.
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
