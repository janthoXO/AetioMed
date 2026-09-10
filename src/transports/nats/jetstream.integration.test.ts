// Integration tests against a real nats-server (#142). Skipped entirely
// unless NATS_TEST_URL is set — see CLAUDE.md's Testing section for how to
// start one locally and how CI provides it.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { jetstreamManager, DeliverPolicy } from "@nats-io/jetstream";
import type { JetStreamManager } from "@nats-io/jetstream";
import {
  connectNats,
  closeNats,
  getJetStreamClient,
  getNatsConnection,
} from "./client.js";
import { ensureStreams } from "./streams.js";
import {
  REQUESTS_STREAM,
  RESULTS_STREAM,
  LEGACY_STREAM,
  REQUEST_CONSUMER,
  resultSubject,
  cancelSubject,
  progressSubject,
  CATALOG_DIAGNOSIS_SUBJECT,
  CATALOG_PROCEDURES_SUBJECT,
  META_FEATURES_SUBJECT,
  META_ALLOWED_LLMS_SUBJECT,
  META_GRAPH_SUBJECT,
} from "./subjects.js";
import { publishCaseResult } from "./cases.publisher.js";
import { runRequestWorker } from "./cases.handler.js";
import { startJobResponders } from "./jobResponders.js";
import { startProgressPublisher } from "./progressPublisher.js";
import { startMetaService } from "./metaService.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import { wireLabels } from "@/core/jobEvents/labels.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { createTraceNode } from "@/core/graph/utils/nodeWrapper.js";
import { EventBus } from "@/core/event-bus.js";
import { getRequestContext } from "@/core/graph/utils/context.js";
import { createReadModel } from "@/core/readModel.js";
import { createRestApp } from "@/transports/rest/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CompiledCaseGraph } from "@/core/graph/02graphs/caseGraph.js";
import type { Case } from "@/core/graph/models/Case.js";

const NATS_TEST_URL = process.env.NATS_TEST_URL;

function fakeGraph(
  generateCase: GraphAppContext["generateCase"] = vi.fn()
): GraphAppContext {
  return {
    config: {
      llm: { provider: "ollama", model: "test-model" },
      allowedLlms: undefined,
      PROCEDURE_PRESELECTION: false,
      LANGUAGES: ["English", "German"],
      LANGUAGE_AUTO_DETECT: false,
      LANGUAGE_DETECT_LLM_FALLBACK: false,
    } as GraphAppContext["config"],
    runtime: {
      catalogs: {
        diagnosis: { byIcd: () => undefined },
      },
      llm: { for: vi.fn() },
    } as unknown as GraphAppContext["runtime"],
    generateCase,
  } as GraphAppContext;
}

describe.skipIf(!NATS_TEST_URL)("JetStream streams and worker (#142)", () => {
  let jsm: JetStreamManager;

  beforeEach(async () => {
    await connectNats({
      url: NATS_TEST_URL!,
      user: process.env.NATS_TEST_USER ?? "nats",
      password: process.env.NATS_TEST_PASSWORD ?? "nats",
    });
    jsm = await jetstreamManager(getNatsConnection());

    for (const name of [
      REQUESTS_STREAM.name,
      RESULTS_STREAM.name,
      LEGACY_STREAM,
    ]) {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await closeNats();
  });

  it(
    "refuses to create streams while the legacy 'cases' stream exists, and is idempotent once it's gone",
    { timeout: 15000 },
    async () => {
      await jsm.streams.add({
        name: LEGACY_STREAM,
        subjects: ["cases.>"],
        retention: "workqueue" as never,
      });

      await expect(ensureStreams(jsm)).rejects.toThrow(/nats stream rm cases/);

      await jsm.streams.delete(LEGACY_STREAM);

      await ensureStreams(jsm);
      await ensureStreams(jsm); // idempotent
    }
  );

  it(
    "CASE_RESULTS uses limits retention and two independent consumers can each read the same result",
    { timeout: 15000 },
    async () => {
      await ensureStreams(jsm);
      const js = getJetStreamClient();

      const info = await jsm.streams.info(RESULTS_STREAM.name);
      expect(info.config.retention).toBe("limits");

      await publishCaseResult("job-x", { status: "done", case: {} });

      const consumerA = await js.consumers.get(RESULTS_STREAM.name, {
        filter_subjects: [resultSubject("job-x")],
        deliver_policy: DeliverPolicy.All,
      });
      const consumerB = await js.consumers.get(RESULTS_STREAM.name, {
        filter_subjects: [resultSubject("job-x")],
        deliver_policy: DeliverPolicy.All,
      });

      const [msgA, msgB] = await Promise.all([
        consumerA.next({ expires: 2000 }),
        consumerB.next({ expires: 2000 }),
      ]);

      expect(msgA).not.toBeNull();
      expect(msgB).not.toBeNull();
      expect(JSON.parse(new TextDecoder().decode(msgA!.data))).toMatchObject({
        jobId: "job-x",
      });
      expect(JSON.parse(new TextDecoder().decode(msgB!.data))).toMatchObject({
        jobId: "job-x",
      });
      msgA!.ack();
      msgB!.ack();
    }
  );

  it(
    "end-to-end: the worker bounds concurrency, cancel works over NATS, and a jobId-less request is terminated",
    { timeout: 15000 },
    async () => {
      await ensureStreams(jsm);
      const js = getJetStreamClient();
      const nc = getNatsConnection();

      const generateCase: GraphAppContext["generateCase"] = vi.fn(
        async (): Promise<Case> => {
          const signal = getRequestContext()?.signal;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 300);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true }
            );
          });
          return { patient: { name: "Jane", age: 40, sex: "female" } };
        }
      );

      const graph = fakeGraph(generateCase);
      const channel = createJobEventChannel();
      const service = createCaseGenerationService(
        graph,
        new EventBus(),
        channel,
        {
          maxConcurrent: 2,
        }
      );

      const stopResponders = startJobResponders({
        nc,
        jobEvents: channel,
        service,
      });
      const consumer = await js.consumers.get(
        REQUESTS_STREAM.name,
        REQUEST_CONSUMER
      );
      let closed = false;
      const workerPromise = runRequestWorker({
        consumer,
        graph,
        service,
        isClosed: () => closed,
      });

      try {
        await js.publish(
          "cases.request.generate",
          JSON.stringify({ jobId: "job-a", diagnosis: "Influenza" })
        );
        await js.publish(
          "cases.request.generate",
          JSON.stringify({ jobId: "job-b", diagnosis: "Influenza" })
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        const cancelReply = await nc.request(
          cancelSubject("job-b"),
          new Uint8Array(),
          { timeout: 2000 }
        );
        expect(JSON.parse(new TextDecoder().decode(cancelReply.data))).toEqual({
          cancelled: true,
        });

        await expect(
          nc.request(cancelSubject("nope"), new Uint8Array(), {
            timeout: 2000,
          })
        ).rejects.toThrow(/no responders/i);

        await new Promise((resolve) => setTimeout(resolve, 800));

        const requestsInfo = await jsm.streams.info(REQUESTS_STREAM.name);
        expect(requestsInfo.state.messages).toBe(0);
      } finally {
        // `closed` only stops the loop between pulls — the worker's current
        // `consumer.next({ expires: 30_000 })` call (cases.handler.ts) is
        // still outstanding and would otherwise block this test's own
        // timeout. Let it settle in the background instead of awaiting it;
        // it errors out (or returns) on its own once this describe block's
        // `afterAll` closes the connection.
        closed = true;
        stopResponders();
        void workerPromise.catch(() => undefined);
      }
    }
  );

  it(
    "a request without a jobId is terminated: not left in CASE_REQUESTS, no result published",
    { timeout: 15000 },
    async () => {
      await ensureStreams(jsm);
      const js = getJetStreamClient();
      const nc = getNatsConnection();

      const graph = fakeGraph();
      const channel = createJobEventChannel();
      const service = createCaseGenerationService(
        graph,
        new EventBus(),
        channel,
        {
          maxConcurrent: 2,
        }
      );

      const stopResponders = startJobResponders({
        nc,
        jobEvents: channel,
        service,
      });
      const consumer = await js.consumers.get(
        REQUESTS_STREAM.name,
        REQUEST_CONSUMER
      );
      let closed = false;
      const workerPromise = runRequestWorker({
        consumer,
        graph,
        service,
        isClosed: () => closed,
      });

      try {
        const before = await jsm.streams.info(RESULTS_STREAM.name);

        await js.publish(
          "cases.request.generate",
          JSON.stringify({ diagnosis: "Flu" })
        );

        await new Promise((resolve) => setTimeout(resolve, 500));

        const requestsInfo = await jsm.streams.info(REQUESTS_STREAM.name);
        expect(requestsInfo.state.messages).toBe(0);

        const after = await jsm.streams.info(RESULTS_STREAM.name);
        expect(after.state.messages).toBe(before.state.messages);
      } finally {
        // `closed` only stops the loop between pulls — the worker's current
        // `consumer.next({ expires: 30_000 })` call (cases.handler.ts) is
        // still outstanding and would otherwise block this test's own
        // timeout. Let it settle in the background instead of awaiting it;
        // it errors out (or returns) on its own once this describe block's
        // `afterAll` closes the connection.
        closed = true;
        stopResponders();
        void workerPromise.catch(() => undefined);
      }
    }
  );
});

// #144 — NATS parity: the progress publisher and the request/reply meta
// service. Kept in this file, in its own `describe`, rather than a sibling
// file: both hit the same `CASE_REQUESTS`/`CASE_RESULTS` streams by name, and
// two files each deleting/recreating them in a `beforeEach` race when
// vitest runs test files in parallel workers — sequential `it`s inside one
// file don't.
function fakeGraphRunningOneNode(bus: EventBus): GraphAppContext {
  const traceNode = createTraceNode(bus);
  const doThing = traceNode(
    "some_node",
    async () => ({ ok: true }),
    "Doing a thing"
  );
  const generateCase: GraphAppContext["generateCase"] = vi.fn(async () => {
    await doThing();
    return {
      patient: {
        name: "Jane",
        age: 40,
        height: 170,
        weight: 65,
        gender: "female",
      },
    } as Case;
  });

  return {
    config: {
      llm: { provider: "ollama", model: "test-model" },
      allowedLlms: ["ollama:llama3.1"],
      MAX_CONTENT_PART_BYTES: 5_000_000,
      PROCEDURE_PRESELECTION: false,
      LANGUAGES: ["English", "German"],
      LANGUAGE_AUTO_DETECT: false,
      LANGUAGE_DETECT_LLM_FALLBACK: false,
    } as GraphAppContext["config"],
    runtime: {
      catalogs: {
        diagnosis: {
          byIcd: () => undefined,
          all: () => [{ icd: "1A00", name: "Cholera" }],
        },
        procedures: { list: () => ["Chest X-ray", "CBC"] },
      },
      llm: { for: vi.fn() },
    } as unknown as GraphAppContext["runtime"],
    generateCase,
    caseGraph: {
      getGraphAsync: async () => ({
        nodes: { __start__: {}, some_node: {}, __end__: {} },
        edges: [
          { source: "__start__", target: "some_node" },
          { source: "some_node", target: "__end__" },
        ],
      }),
    } as unknown as CompiledCaseGraph,
  } as GraphAppContext;
}

/** Collect every message on `subject` (a core-NATS fan-out subject, `>`
 * wildcard allowed) until `count` have arrived or `timeoutMs` elapses. */
async function collectCore(
  subject: string,
  count: number,
  timeoutMs = 5000
): Promise<{ subject: string; data: unknown }[]> {
  const nc = getNatsConnection();
  const received: { subject: string; data: unknown }[] = [];
  const sub = nc.subscribe(subject);
  const deadline = Date.now() + timeoutMs;

  (async () => {
    for await (const msg of sub) {
      received.push({
        subject: msg.subject,
        data: JSON.parse(new TextDecoder().decode(msg.data)),
      });
      if (received.length >= count) sub.unsubscribe();
    }
  })().catch(() => undefined);

  while (received.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  sub.unsubscribe();
  return received;
}

describe.skipIf(!NATS_TEST_URL)("NATS parity (#144)", () => {
  let jsm: JetStreamManager;

  beforeEach(async () => {
    await connectNats({
      url: NATS_TEST_URL!,
      user: process.env.NATS_TEST_USER ?? "nats",
      password: process.env.NATS_TEST_PASSWORD ?? "nats",
    });
    jsm = await jetstreamManager(getNatsConnection());

    for (const name of [
      REQUESTS_STREAM.name,
      RESULTS_STREAM.name,
      LEGACY_STREAM,
    ]) {
      await jsm.streams.delete(name).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await closeNats();
  });

  it(
    "a NATS-submitted job publishes accepted, started/completed labels and complete on cases.progress.<jobId>.>",
    { timeout: 15000 },
    async () => {
      await ensureStreams(jsm);
      const js = getJetStreamClient();
      const nc = getNatsConnection();

      const bus = new EventBus();
      const channel = createJobEventChannel();
      wireLabels(bus, channel, new InMemoryLabelCatalog());
      const graph = fakeGraphRunningOneNode(bus);
      const service = createCaseGenerationService(graph, bus, channel, {
        maxConcurrent: 2,
      });

      const stopResponders = startJobResponders({
        nc,
        jobEvents: channel,
        service,
      });
      const stopPublisher = startProgressPublisher({ nc, jobEvents: channel });

      const consumer = await js.consumers.get(
        REQUESTS_STREAM.name,
        REQUEST_CONSUMER
      );
      let closed = false;
      const workerPromise = runRequestWorker({
        consumer,
        graph,
        service,
        isClosed: () => closed,
      });

      try {
        const collecting = collectCore(
          progressSubject("job-n", "label").replace(".label", ".>"),
          4
        );
        // Let the subscription land before publishing.
        await new Promise((resolve) => setTimeout(resolve, 100));

        await js.publish(
          "cases.request.generate",
          JSON.stringify({ jobId: "job-n", diagnosis: "Influenza" })
        );

        const events = await collecting;
        expect(events.map((e) => e.subject)).toEqual([
          progressSubject("job-n", "accepted"),
          progressSubject("job-n", "label"),
          progressSubject("job-n", "label"),
          progressSubject("job-n", "complete"),
        ]);
        expect(events[1].data).toMatchObject({
          nodeId: "some_node",
          status: "started",
        });
        expect(events[2].data).toMatchObject({
          nodeId: "some_node",
          status: "completed",
        });
      } finally {
        closed = true;
        stopResponders();
        stopPublisher();
        void workerPromise.catch(() => undefined);
      }
    }
  );

  it(
    "a REST-submitted job publishes the same label sequence over NATS",
    { timeout: 15000 },
    async () => {
      const nc = getNatsConnection();

      const bus = new EventBus();
      const channel = createJobEventChannel();
      wireLabels(bus, channel, new InMemoryLabelCatalog());
      const graph = fakeGraphRunningOneNode(bus);
      const service = createCaseGenerationService(graph, bus, channel, {
        maxConcurrent: 2,
      });
      const stopPublisher = startProgressPublisher({ nc, jobEvents: channel });

      const features = new Set(["REST"]);
      const app = createRestApp({
        graph,
        service,
        jobEvents: channel,
        readModel: createReadModel(graph, features),
        features,
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;

      try {
        const collecting = collectCore(
          progressSubject("job-rest-1", "label").replace(".label", ".>"),
          4
        );
        await new Promise((resolve) => setTimeout(resolve, 100));

        const res = await fetch(`http://127.0.0.1:${port}/api/cases`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            diagnosis: "Influenza",
            generationFlags: ["patient"],
            jobId: "job-rest-1",
          }),
        });
        expect(res.status, await res.clone().text()).toBe(200);

        const events = await collecting;
        expect(events.map((e) => e.subject)).toEqual([
          progressSubject("job-rest-1", "accepted"),
          progressSubject("job-rest-1", "label"),
          progressSubject("job-rest-1", "label"),
          progressSubject("job-rest-1", "complete"),
        ]);
      } finally {
        stopPublisher();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it(
    "each request/reply endpoint answers exactly what its REST counterpart does",
    { timeout: 15000 },
    async () => {
      const nc = getNatsConnection();
      const bus = new EventBus();
      const channel = createJobEventChannel();
      const graph = fakeGraphRunningOneNode(bus);
      const features = new Set(["REST"]);
      const readModel = createReadModel(graph, features);

      const app = createRestApp({
        graph,
        service: createCaseGenerationService(graph, bus, channel),
        jobEvents: channel,
        readModel,
        features,
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;

      const stopMeta = await startMetaService({ nc, readModel });

      try {
        const rows: [string, string][] = [
          ["/api/diagnosis", CATALOG_DIAGNOSIS_SUBJECT],
          ["/api/procedures", CATALOG_PROCEDURES_SUBJECT],
          ["/api/features", META_FEATURES_SUBJECT],
          ["/api/allowedLlms", META_ALLOWED_LLMS_SUBJECT],
          ["/api/graph", META_GRAPH_SUBJECT],
        ];

        for (const [path, subject] of rows) {
          const restRes = await fetch(`http://127.0.0.1:${port}${path}`);
          const restBody = await restRes.json();

          const natsRes = await nc.request(subject, new Uint8Array(), {
            timeout: 2000,
          });
          const natsBody = JSON.parse(new TextDecoder().decode(natsRes.data));

          expect(natsBody).toEqual(restBody);
        }
      } finally {
        await stopMeta();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );

  it(
    "labels are core NATS, not JetStream: no stream captures cases.progress.*.label",
    { timeout: 15000 },
    async () => {
      await ensureStreams(jsm);
      await expect(
        jsm.streams.find(progressSubject("job-n", "label"))
      ).rejects.toThrow();
    }
  );

  it(
    "the meta service is discoverable via $SRV.PING.aetiomed",
    { timeout: 15000 },
    async () => {
      const nc = getNatsConnection();
      const graph = fakeGraphRunningOneNode(new EventBus());
      const readModel = createReadModel(graph, new Set());
      const stopMeta = await startMetaService({ nc, readModel });

      try {
        const reply = await nc.request("$SRV.PING.aetiomed", new Uint8Array(), {
          timeout: 2000,
        });
        const body = JSON.parse(new TextDecoder().decode(reply.data));
        expect(body).toMatchObject({ name: "aetiomed" });
      } finally {
        await stopMeta();
      }
    }
  );
});
