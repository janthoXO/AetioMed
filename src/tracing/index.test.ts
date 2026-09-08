// Issue 15 §1.1/§1.2/§3/§6 — `wireTracing` forwards node-execution bus
// events onto two separate per-job channels: `trace` (English, node output,
// operator-facing) and `label` (localized, falling back to English,
// end-user-facing). These tests drive the wiring directly against a real
// `EventBus`/`TraceBus`, without an HTTP layer.
import { describe, expect, it } from "vitest";
import { EventBus } from "@/core/event-bus.js";
import { registerJobHook, runWithContext } from "@/core/graph/utils/context.js";
import { InMemoryLabelCatalog } from "@/core/graph/catalog/labels/index.js";
import { wireTracing, setupTracing, getTraceBus } from "./index.js";
import type { TraceEvent, LabelEvent } from "./index.js";

function collect(jobId: string) {
  const bus = getTraceBus(jobId)!;
  const traces: TraceEvent[] = [];
  const labels: LabelEvent[] = [];
  bus.on("trace", (e: TraceEvent) => traces.push(e));
  bus.on("label", (e: LabelEvent) => labels.push(e));
  return { traces, labels };
}

describe("wireTracing — labels vs traces (issue 15 §1)", () => {
  it("a completed node emits an English `trace` event and a localized `label` event, on separate channels", async () => {
    const bus = new EventBus();
    const labelCatalog = new InMemoryLabelCatalog({
      "Resolving medical basis": {
        German: "Medizinische Basis wird aufgelöst",
      },
    });
    wireTracing(bus, labelCatalog, 5_000_000);
    registerJobHook(setupTracing);

    await runWithContext(
      async () => {
        const { traces, labels } = collect("job-1");

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
          labelKey: "Resolving medical basis", // English, always
        });
        expect(traces[1]).toMatchObject({
          kind: "node_completed",
          nodeId: "basis_resolve",
          labelKey: "Resolving medical basis",
          output: { truncated: false, value: { basisFragments: ["x"] } },
        });

        expect(labels).toHaveLength(2);
        expect(labels[0]).toMatchObject({
          nodeId: "basis_resolve",
          status: "started",
          label: "Medizinische Basis wird aufgelöst", // localized
        });
        expect(labels[1].label).toBe("Medizinische Basis wird aufgelöst");
      },
      "job-1",
      undefined,
      "German"
    );
  });

  it("falls back to the English label when no translation exists — never fatal", async () => {
    const bus = new EventBus();
    const labelCatalog = new InMemoryLabelCatalog(); // no translations at all
    wireTracing(bus, labelCatalog, 5_000_000);
    registerJobHook(setupTracing);

    await runWithContext(
      async () => {
        const { labels, traces } = collect("job-2");

        await bus.emit("Node Started", {
          node: "basis_resolve",
          label: "Resolving medical basis",
          jobId: "job-2",
          timestamp: "t0",
        });

        expect(labels[0].label).toBe("Resolving medical basis"); // English fallback
        expect(traces[0].labelKey).toBe("Resolving medical basis");
      },
      "job-2",
      undefined,
      "German"
    );
  });

  it("a failed node emits a node_failed trace and a failed-status label, carrying the error", async () => {
    const bus = new EventBus();
    const labelCatalog = new InMemoryLabelCatalog();
    wireTracing(bus, labelCatalog, 5_000_000);
    registerJobHook(setupTracing);

    await runWithContext(
      async () => {
        const { traces, labels } = collect("job-3");

        await bus.emit("Node Failed", {
          node: "basis_resolve",
          label: "Resolving medical basis",
          error: "boom",
          jobId: "job-3",
          timestamp: "t0",
        });

        expect(traces[0]).toMatchObject({
          kind: "node_failed",
          nodeId: "basis_resolve",
          error: "boom",
        });
        expect(labels[0]).toMatchObject({
          nodeId: "basis_resolve",
          status: "failed",
        });
      },
      "job-3",
      undefined,
      undefined
    );
  });

  it("an English-language job gets English labels (no-op localization) and English traces — the same content on both channels", async () => {
    const bus = new EventBus();
    const labelCatalog = new InMemoryLabelCatalog({
      "Resolving medical basis": { German: "anders" },
    });
    wireTracing(bus, labelCatalog, 5_000_000);
    registerJobHook(setupTracing);

    await runWithContext(
      async () => {
        const { traces, labels } = collect("job-4");
        await bus.emit("Node Started", {
          node: "basis_resolve",
          label: "Resolving medical basis",
          jobId: "job-4",
          timestamp: "t0",
        });

        expect(labels[0].label).toBe("Resolving medical basis");
        expect(traces[0].labelKey).toBe("Resolving medical basis");
      },
      "job-4",
      undefined,
      "English"
    );
  });
});
