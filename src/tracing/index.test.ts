// #139 — labels moved to `core/jobEvents/labels.ts` and are tested there
// now; this file drives only `wireTracing(bus, channel, maxContentPartBytes)`
// against a real `EventBus` + `createJobEventChannel()`.
import { describe, expect, it } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import {
  createJobEventChannel,
  type JobEvent,
} from "@/core/jobEvents/channel.js";
import { encodeText } from "@/core/graph/models/ContentPart.js";
import type { Case } from "@/core/graph/models/Case.js";
import { wireTracing } from "./index.js";
import type { TraceEvent } from "./index.js";

function collectTraces(
  channel: ReturnType<typeof createJobEventChannel>,
  jobId: string
): TraceEvent[] {
  const traces: TraceEvent[] = [];
  const sub = channel.subscribe(jobId, (event: JobEvent) => {
    if (event.type === "trace") traces.push(event.data);
  });
  if (sub.state !== "active") throw new Error("expected an active job");
  return traces;
}

describe("wireTracing (#139)", () => {
  it("Node Started + Node Completed emit two trace events with kind, nodeId, English labelKey, and a capped output", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireTracing(bus, channel, 5_000_000);
    channel.open("job-1");
    const traces = collectTraces(channel, "job-1");

    await bus.emit("Node Started", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      jobId: "job-1",
      timestamp: "t0",
    });
    await bus.emit("Node Completed", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      result: { basisFragments: ["x"] },
      jobId: "job-1",
      timestamp: "t1",
    });

    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({
      kind: "node_started",
      nodeId: "basis_resolve",
      labelKey: "Resolving medical basis",
    });
    expect(traces[1]).toMatchObject({
      kind: "node_completed",
      nodeId: "basis_resolve",
      labelKey: "Resolving medical basis",
      output: { truncated: false, value: { basisFragments: ["x"] } },
    });
  });

  it("Node Failed emits a node_failed trace carrying the error", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireTracing(bus, channel, 5_000_000);
    channel.open("job-2");
    const traces = collectTraces(channel, "job-2");

    await bus.emit("Node Failed", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      error: "boom",
      jobId: "job-2",
      timestamp: "t0",
    });

    expect(traces[0]).toMatchObject({
      kind: "node_failed",
      nodeId: "basis_resolve",
      error: "boom",
    });
  });

  it("Generation Completed emits a generation_completed trace whose case is wire-encoded, not raw bytes", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireTracing(bus, channel, 5_000_000);
    channel.open("job-3");
    const traces = collectTraces(channel, "job-3");

    const generatedCase: Case = {
      patient: { name: "Jane", age: 40, sex: "female" },
      chiefComplaint: [
        { type: "text/plain", value: encodeText("hi"), alt: "hi" },
      ],
    };

    await bus.emit("Generation Completed", {
      case: generatedCase,
      jobId: "job-3",
    });

    expect(traces).toHaveLength(1);
    expect(traces[0]?.kind).toBe("generation_completed");
    const event = traces[0] as Extract<
      TraceEvent,
      { kind: "generation_completed" }
    >;
    const wireCase = event.case as {
      chiefComplaint: { value: string }[];
    };
    expect(wireCase.chiefComplaint[0]?.value).toBe("hi");
  });
});
