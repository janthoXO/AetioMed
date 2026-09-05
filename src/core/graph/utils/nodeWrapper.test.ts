// Issue 15 §2 — the two defects fixed as their own change, ahead of the
// feature work in §3-§5: `traceNode` had no `try`/`catch`, so a throwing
// node emitted "Node Started" and never a terminal event. These tests pin
// down the fix directly against the bus, independent of the typed
// `TraceEvent`/OTel work layered on top later in this file's neighbours.
import { describe, expect, it } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import { createTraceNode, getNodeLabels } from "./nodeWrapper.js";
import type { NodeSpan, NodeTracer } from "./nodeWrapper.js";
import { runWithContext } from "./context.js";
import type { LLMConfig } from "@/core/graph/models/LLMConfig.js";

function fakeTracer() {
  const spans: {
    nodeId: string;
    jobId?: string;
    outputBytes?: number;
    llm?: { provider: string; model: string };
    failed?: string;
    ended: boolean;
  }[] = [];

  const tracer: NodeTracer = {
    startSpan(nodeId, attrs) {
      const record: (typeof spans)[number] = { nodeId, ended: false };
      if (attrs.jobId !== undefined) record.jobId = attrs.jobId;
      spans.push(record);
      const span: NodeSpan = {
        setOutputBytes(bytes) {
          record.outputBytes = bytes;
        },
        setLlm(provider, model) {
          record.llm = { provider, model };
        },
        fail(message) {
          record.failed = message;
        },
        end() {
          record.ended = true;
        },
      };
      return span;
    },
  };

  return { tracer, spans };
}

describe("traceNode — terminal-event pairing (issue 15 §2)", () => {
  it("a successful node emits Node Started then Node Completed, and returns the result", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("Node Started", () => events.push("Node Started"));
    bus.on("Node Completed", () => events.push("Node Completed"));
    bus.on("Node Failed", () => events.push("Node Failed"));

    const traceNode = createTraceNode(bus);
    const wrapped = traceNode("ok_node", async () => "value", "Doing a thing");

    await expect(wrapped()).resolves.toBe("value");
    // Bus handlers run synchronously inside `emit`, awaited by `traceNode`,
    // so by the time the wrapped call resolves both events have landed.
    expect(events).toEqual(["Node Started", "Node Completed"]);
  });

  it("a throwing node emits Node Started then Node Failed (never Node Completed), and rethrows", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("Node Started", () => events.push("Node Started"));
    bus.on("Node Completed", () => events.push("Node Completed"));
    bus.on("Node Failed", (payload) => {
      events.push("Node Failed");
      expect(payload.error).toBe("boom");
      expect(payload.node).toBe("failing_node");
    });

    const traceNode = createTraceNode(bus);
    const wrapped = traceNode(
      "failing_node",
      async () => {
        throw new Error("boom");
      },
      "Doing a thing that fails"
    );

    // The error must still propagate — traceNode instruments, it does not
    // swallow.
    await expect(wrapped()).rejects.toThrow("boom");
    expect(events).toEqual(["Node Started", "Node Failed"]);
    expect(events).not.toContain("Node Completed");
  });

  it("a non-Error throw is stringified onto the Node Failed event, and still rethrows", async () => {
    const bus = new EventBus();
    let failedError: string | undefined;
    bus.on("Node Failed", (payload) => {
      failedError = payload.error;
    });

    const traceNode = createTraceNode(bus);
    const wrapped = traceNode(
      "throws_string",
      async () => {
        throw "not an Error object";
      },
      "Doing a thing"
    );

    await expect(wrapped()).rejects.toBe("not an Error object");
    expect(failedError).toBe("not an Error object");
  });

  it("records the node id -> labelKey mapping the structure endpoint (§4) joins against", () => {
    const bus = new EventBus();
    const traceNode = createTraceNode(bus);
    traceNode("labeled_node", async () => undefined, "A human label");

    expect(getNodeLabels()).toMatchObject({
      labeled_node: "A human label",
    });
  });
});

describe("traceNode — OTel span lifecycle (issue 15 §5)", () => {
  it("a successful node opens and closes exactly one span, carrying jobId and output size", async () => {
    const bus = new EventBus();
    const { tracer, spans } = fakeTracer();
    const traceNode = createTraceNode(bus, tracer);
    const wrapped = traceNode(
      "ok_node",
      async () => ({ value: "x".repeat(100) }),
      "Doing a thing"
    );

    await runWithContext(() => wrapped(), "job-otel-1");

    expect(spans).toHaveLength(1);
    expect(spans[0].nodeId).toBe("ok_node");
    expect(spans[0].jobId).toBe("job-otel-1");
    expect(spans[0].ended).toBe(true);
    expect(spans[0].failed).toBeUndefined();
    expect(spans[0].outputBytes).toBeGreaterThan(0);
  });

  it("a failing node ends its span via fail(), and the error still propagates", async () => {
    const bus = new EventBus();
    const { tracer, spans } = fakeTracer();
    const traceNode = createTraceNode(bus, tracer);
    const wrapped = traceNode(
      "failing_node",
      async () => {
        throw new Error("boom");
      },
      "Doing a thing that fails"
    );

    await expect(runWithContext(() => wrapped(), "job-otel-2")).rejects.toThrow(
      "boom"
    );

    expect(spans).toHaveLength(1);
    expect(spans[0].ended).toBe(true);
    expect(spans[0].failed).toBe("boom");
  });

  it("carries the per-request llmConfig's provider/model onto the span, when set", async () => {
    const bus = new EventBus();
    const { tracer, spans } = fakeTracer();
    const traceNode = createTraceNode(bus, tracer);
    const wrapped = traceNode("ok_node", async () => "value", "Doing a thing");

    const llmConfig: LLMConfig = {
      provider: "google",
      model: "gemini-2.0-flash",
      outputFormat: "json",
    };
    await runWithContext(() => wrapped(), "job-otel-3", llmConfig);

    expect(spans[0].llm).toEqual({
      provider: "google",
      model: "gemini-2.0-flash",
    });
  });

  it("defaults to the no-op tracer (createTraceNode(bus) alone), touching nothing observable", async () => {
    const bus = new EventBus();
    const traceNode = createTraceNode(bus); // no tracer argument
    const wrapped = traceNode("ok_node", async () => "value", "Doing a thing");

    await expect(wrapped()).resolves.toBe("value");
  });

  it(".scope() carries the tracer through, so a nested node's span still reaches it", async () => {
    const bus = new EventBus();
    const { tracer, spans } = fakeTracer();
    const traceNode = createTraceNode(bus, tracer).scope("outer_phase");
    const wrapped = traceNode("inner_node", async () => "value", "A label");

    await wrapped();

    expect(spans).toHaveLength(1);
    expect(spans[0].nodeId).toBe("outer_phase:inner_node");
  });
});
