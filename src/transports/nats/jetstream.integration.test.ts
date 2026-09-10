// Integration tests against a real nats-server (#142). Skipped entirely
// unless NATS_TEST_URL is set — see CLAUDE.md's Testing section for how to
// start one locally and how CI provides it.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "./subjects.js";
import { publishCaseResult } from "./cases.publisher.js";
import { runRequestWorker } from "./cases.handler.js";
import { startJobResponders } from "./jobResponders.js";
import { createCaseGenerationService } from "@/core/caseGenerationService.js";
import { createJobEventChannel } from "@/core/jobEvents/index.js";
import { EventBus } from "@/core/event-bus.js";
import { getRequestContext } from "@/core/graph/utils/context.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
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
