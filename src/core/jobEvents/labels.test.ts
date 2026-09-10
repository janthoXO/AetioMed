// #139 — `wireLabels` forwards the graph's node lifecycle onto the per-job
// channel as localized `label` events. Ported from the old
// `src/tracing/index.test.ts`, which used to test this behavior mixed in
// with traces on a since-deleted `TraceBus`; labels are a core concern now
// (see `labels.ts`'s doc comment) and are driven here against a real
// `EventBus` + `createJobEventChannel()`, with `language` passed directly on
// the bus event rather than via `runWithContext`.
import { describe, expect, it } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import { createJobEventChannel, type JobEvent } from "./channel.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { wireLabels, type LabelEvent } from "./labels.js";

function collectLabels(
  channel: ReturnType<typeof createJobEventChannel>,
  jobId: string
): LabelEvent[] {
  const labels: LabelEvent[] = [];
  const sub = channel.subscribe(jobId, (event: JobEvent) => {
    if (event.type === "label") labels.push(event.data);
  });
  if (sub.state !== "active") throw new Error("expected an active job");
  return labels;
}

describe("wireLabels (#139)", () => {
  it("a completed node emits started and completed label events, localized", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    const labelCatalog = new InMemoryLabelCatalog({
      "Resolving medical basis": {
        German: "Medizinische Basis wird aufgelöst",
      },
    });
    wireLabels(bus, channel, labelCatalog);
    channel.open("job-1");
    const labels = collectLabels(channel, "job-1");

    await bus.emit("Node Started", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      jobId: "job-1",
      language: "German",
      timestamp: "t0",
    });
    await bus.emit("Node Completed", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      result: { basisFragments: ["x"] },
      jobId: "job-1",
      language: "German",
      timestamp: "t1",
    });

    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatchObject({
      nodeId: "basis_resolve",
      status: "started",
      label: "Medizinische Basis wird aufgelöst",
    });
    expect(labels[1]).toMatchObject({
      nodeId: "basis_resolve",
      status: "completed",
      label: "Medizinische Basis wird aufgelöst",
    });
  });

  it("falls back to the English label when no translation exists — never fatal", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    const labelCatalog = new InMemoryLabelCatalog(); // no translations at all
    wireLabels(bus, channel, labelCatalog);
    channel.open("job-2");
    const labels = collectLabels(channel, "job-2");

    await bus.emit("Node Started", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      jobId: "job-2",
      language: "German",
      timestamp: "t0",
    });

    expect(labels[0]?.label).toBe("Resolving medical basis"); // English fallback
  });

  it("`Node Failed` emits a failed-status label, carrying no node output", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireLabels(bus, channel, new InMemoryLabelCatalog());
    channel.open("job-3");
    const labels = collectLabels(channel, "job-3");

    await bus.emit("Node Failed", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      error: "boom",
      jobId: "job-3",
      timestamp: "t0",
    });

    expect(labels[0]).toMatchObject({
      nodeId: "basis_resolve",
      status: "failed",
    });
  });

  it("an English job gets the English label unchanged (no-op localization)", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    const labelCatalog = new InMemoryLabelCatalog({
      "Resolving medical basis": { German: "anders" },
    });
    wireLabels(bus, channel, labelCatalog);
    channel.open("job-4");
    const labels = collectLabels(channel, "job-4");

    await bus.emit("Node Started", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      jobId: "job-4",
      language: "English",
      timestamp: "t0",
    });

    expect(labels[0]?.label).toBe("Resolving medical basis");
  });

  it("never carries node output — a completed event's keys are exactly jobId/label/nodeId/status/timestamp", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireLabels(bus, channel, new InMemoryLabelCatalog());
    channel.open("job-5");
    let labelEvent: LabelEvent | undefined;
    const sub = channel.subscribe("job-5", (event) => {
      if (event.type === "label") labelEvent = event.data;
    });
    if (sub.state !== "active") throw new Error("expected an active job");

    await bus.emit("Node Completed", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      result: { secret: "x".repeat(100) },
      jobId: "job-5",
      timestamp: "t1",
    });

    expect(labelEvent).toBeDefined();
    expect(JSON.stringify(labelEvent)).not.toContain("secret");
    expect(Object.keys(labelEvent!).sort()).toEqual(
      ["jobId", "label", "nodeId", "status", "timestamp"].sort()
    );
  });

  it("drops an event for a jobId that was never opened — no throw, other jobs unaffected", async () => {
    const bus = new EventBus();
    const channel = createJobEventChannel();
    wireLabels(bus, channel, new InMemoryLabelCatalog());
    channel.open("job-other");
    const otherLabels = collectLabels(channel, "job-other");

    await bus.emit("Node Started", {
      node: "basis_resolve",
      label: "Resolving medical basis",
      jobId: "job-never-opened",
      timestamp: "t0",
    });

    expect(otherLabels).toHaveLength(0);
  });
});
