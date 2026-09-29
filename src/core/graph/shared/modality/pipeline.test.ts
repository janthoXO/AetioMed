import { describe, expect, it } from "vitest";
import { renderPlan } from "./pipeline.js";
import type { ModalityPlan, ModalityProvider } from "./ports.js";
import z from "zod";
import { createLogger } from "@/core/graph/utils/logger.js";
import { EventBus } from "@/core/event-bus.js";

function noopLogger() {
  return createLogger(new EventBus());
}

function makeCountingTextProvider(): {
  provider: ModalityProvider<unknown>;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const provider: ModalityProvider<unknown> = {
    id: "text",
    mime: "text/plain",
    description: "test text provider",
    inputSchema: z.unknown(),
    render: async (batch) => {
      calls.push(batch);
      return (batch as { instruction: string }[]).map((b) =>
        new TextEncoder().encode(b.instruction)
      );
    },
  };
  return { provider, calls };
}

describe("renderPlan — batching", () => {
  it("makes exactly ONE render call per provider, carrying every unit's requests for that provider", async () => {
    const { provider, calls } = makeCountingTextProvider();
    const plan: ModalityPlan = {
      "Current Symptoms": [
        { provider: "text", input: { instruction: "fever" }, alt: "Fever." },
      ],
      "Past Illnesses": [
        { provider: "text", input: { instruction: "none" }, alt: "None." },
      ],
    };

    const result = await renderPlan([provider], plan, undefined, noopLogger());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { instruction: "fever" },
      { instruction: "none" },
    ]);
    expect(
      new TextDecoder().decode(result["Current Symptoms"]![0]!.value)
    ).toBe("fever");
    expect(new TextDecoder().decode(result["Past Illnesses"]![0]!.value)).toBe(
      "none"
    );
    expect(result["Current Symptoms"]![0]!.alt).toBe("Fever.");
  });
});

describe("renderPlan — planned order, not completion order", () => {
  it("scatters results back in PLANNED order — the first-planned request resolves last", async () => {
    const slow: ModalityProvider<unknown> = {
      id: "slow",
      mime: "application/x-slow",
      description: "slow",
      inputSchema: z.unknown(),
      render: async (batch) => {
        await new Promise((r) => setTimeout(r, 30));
        return (batch as string[]).map((v) =>
          new TextEncoder().encode(`slow:${v}`)
        );
      },
    };
    const fast: ModalityProvider<unknown> = {
      id: "fast",
      mime: "application/x-fast",
      description: "fast",
      inputSchema: z.unknown(),
      render: async (batch) =>
        (batch as string[]).map((v) => new TextEncoder().encode(`fast:${v}`)),
    };

    const plan: ModalityPlan = {
      unit: [
        { provider: "slow", input: "a", alt: "slow alt" },
        { provider: "fast", input: "b", alt: "fast alt" },
      ],
    };

    const result = await renderPlan(
      [slow, fast],
      plan,
      undefined,
      noopLogger()
    );

    expect(result.unit!.map((p) => p.type)).toEqual([
      "application/x-slow",
      "application/x-fast",
    ]);
    expect(new TextDecoder().decode(result.unit![0]!.value)).toBe("slow:a");
    expect(new TextDecoder().decode(result.unit![1]!.value)).toBe("fast:b");
  });
});

describe("renderPlan — failure policy", () => {
  it("logs and drops a throwing provider's parts, without failing units another provider still served", async () => {
    const throwing: ModalityProvider<unknown> = {
      id: "broken",
      mime: "application/x-broken",
      description: "always throws",
      inputSchema: z.unknown(),
      render: async () => {
        throw new Error("boom");
      },
    };
    const ok: ModalityProvider<unknown> = {
      id: "ok",
      mime: "text/plain",
      description: "ok",
      inputSchema: z.unknown(),
      render: async (batch) =>
        (batch as string[]).map((v) => new TextEncoder().encode(v)),
    };

    const plan: ModalityPlan = {
      mixed: [
        { provider: "broken", input: "x", alt: "broken alt" },
        { provider: "ok", input: "kept", alt: "kept alt" },
      ],
    };

    const result = await renderPlan(
      [throwing, ok],
      plan,
      undefined,
      noopLogger()
    );

    expect(result.mixed).toHaveLength(1);
    expect(result.mixed![0]!.alt).toBe("kept alt");
  });

  it("drops parts for a provider id the plan names but the registry does not carry", async () => {
    const plan: ModalityPlan = {
      unit: [{ provider: "missing", input: "x", alt: "x" }],
    };

    await expect(renderPlan([], plan, undefined, noopLogger())).rejects.toThrow(
      /zero parts/i
    );
  });

  it("throws when a unit is left with zero parts after every provider for it failed", async () => {
    const throwing: ModalityProvider<unknown> = {
      id: "broken",
      mime: "application/x-broken",
      description: "always throws",
      inputSchema: z.unknown(),
      render: async () => {
        throw new Error("boom");
      },
    };
    const plan: ModalityPlan = {
      unit: [{ provider: "broken", input: "x", alt: "x" }],
    };

    await expect(
      renderPlan([throwing], plan, undefined, noopLogger())
    ).rejects.toThrow(/zero parts/i);
  });
});
