// #145 — `selectJobDirectory`: with both `REST` and `NATS` enabled, REST
// rides NATS for its job directory; otherwise (or if NATS failed to
// connect) it falls back to the in-process one. A pure function, tested
// directly rather than through `createApp()`.
import { describe, expect, it, vi } from "vitest";
import { selectJobDirectory } from "./app.js";
import {
  createJobEventChannel,
  createLocalJobDirectory,
} from "./jobEvents/index.js";
import { createNatsJobDirectory } from "../transports/nats/jobDirectory.js";
import type { NatsConnection } from "@nats-io/transport-node";

function fakeLocal() {
  return createLocalJobDirectory(createJobEventChannel(), () => false);
}

function fakeNats() {
  return createNatsJobDirectory({} as NatsConnection);
}

describe("selectJobDirectory (#145)", () => {
  it("features {REST} → local", () => {
    const local = fakeLocal();
    const result = selectJobDirectory({
      features: new Set(["REST"]),
      local,
      nats: fakeNats(),
    });
    expect(result).toBe(local);
  });

  it("features {REST, NATS} with a nats directory → nats", () => {
    const local = fakeLocal();
    const nats = fakeNats();
    const result = selectJobDirectory({
      features: new Set(["REST", "NATS"]),
      local,
      nats,
    });
    expect(result).toBe(nats);
  });

  it("features {REST, NATS} without one (NATS failed to connect) → local, with a console.warn", () => {
    const local = fakeLocal();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = selectJobDirectory({
      features: new Set(["REST", "NATS"]),
      local,
      nats: undefined,
    });

    expect(result).toBe(local);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
