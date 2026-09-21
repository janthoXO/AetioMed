import { describe, it, expect } from "vitest";
import { createLimiter } from "./concurrency.js";

describe("createLimiter", () => {
  it("throws for a non-positive or non-integer max", () => {
    expect(() => createLimiter(0)).toThrow();
    expect(() => createLimiter(-1)).toThrow();
    expect(() => createLimiter(1.5)).toThrow();
  });

  it("grants immediately while under the limit, tracking active/waiting", async () => {
    const limiter = createLimiter(2);
    expect(limiter.active).toBe(0);
    expect(limiter.waiting).toBe(0);

    const release1 = await limiter.acquire();
    expect(limiter.active).toBe(1);
    const release2 = await limiter.acquire();
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(0);

    release1();
    release2();
    expect(limiter.active).toBe(0);
  });

  it("queues past the limit and grants in FIFO order", async () => {
    const limiter = createLimiter(1);
    const release1 = await limiter.acquire();
    expect(limiter.active).toBe(1);

    const order: number[] = [];
    const p1 = limiter.acquire().then((release) => {
      order.push(1);
      return release;
    });
    const p2 = limiter.acquire().then((release) => {
      order.push(2);
      return release;
    });
    expect(limiter.waiting).toBe(2);

    release1();
    const release2 = await p1;
    expect(order).toEqual([1]);
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(1);

    release2();
    const release3 = await p2;
    expect(order).toEqual([1, 2]);
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(0);

    release3();
    expect(limiter.active).toBe(0);
  });

  it("release is idempotent: a double release does not free two slots", async () => {
    const limiter = createLimiter(1);
    const release1 = await limiter.acquire();

    let grantedSecond = false;
    const p2 = limiter.acquire().then((release) => {
      grantedSecond = true;
      return release;
    });

    release1();
    release1(); // double release
    await p2;
    expect(grantedSecond).toBe(true);
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(0);

    // No third waiter should have been granted by the extra release.
    const p3 = limiter.acquire();
    let grantedThird = false;
    void p3.then(() => (grantedThird = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(grantedThird).toBe(false);
    expect(limiter.waiting).toBe(1);
  });

  it("a waiter whose signal aborts is removed, rejects with AbortError, and consumes no slot", async () => {
    const limiter = createLimiter(1);
    const release1 = await limiter.acquire();
    expect(limiter.active).toBe(1);

    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    expect(limiter.waiting).toBe(1);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(limiter.waiting).toBe(0);

    // The slot is still held by release1; releasing it now should grant a
    // fresh waiter rather than the aborted one.
    let granted = false;
    const p2 = limiter.acquire().then((release) => {
      granted = true;
      return release;
    });
    release1();
    await p2;
    expect(granted).toBe(true);
    expect(limiter.active).toBe(1);
  });

  it("an already-aborted signal rejects immediately without queueing", async () => {
    const limiter = createLimiter(1);
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(limiter.waiting).toBe(0);
    expect(limiter.active).toBe(0);
  });

  it("a high-priority waiter queued after normal waiters is granted first", async () => {
    const limiter = createLimiter(1);
    const release1 = await limiter.acquire();

    const order: string[] = [];
    const pNormal = limiter.acquire().then((release) => {
      order.push("normal");
      return release;
    });
    const pHigh = limiter
      .acquire(undefined, { priority: "high" })
      .then((release) => {
        order.push("high");
        return release;
      });
    expect(limiter.waiting).toBe(2);
    expect(limiter.waitingHigh).toBe(1);

    release1();
    const releaseHigh = await pHigh;
    expect(order).toEqual(["high"]);
    expect(limiter.waitingHigh).toBe(0);
    expect(limiter.waiting).toBe(1);

    releaseHigh();
    await pNormal;
    expect(order).toEqual(["high", "normal"]);
    expect(limiter.waiting).toBe(0);
  });

  it("is FIFO within the high lane and within the normal lane", async () => {
    const limiter = createLimiter(1);
    const release1 = await limiter.acquire();

    const order: string[] = [];
    const pHigh1 = limiter
      .acquire(undefined, { priority: "high" })
      .then((r) => {
        order.push("high1");
        return r;
      });
    const pHigh2 = limiter
      .acquire(undefined, { priority: "high" })
      .then((r) => {
        order.push("high2");
        return r;
      });
    const pNormal1 = limiter.acquire().then((r) => {
      order.push("normal1");
      return r;
    });
    const pNormal2 = limiter.acquire().then((r) => {
      order.push("normal2");
      return r;
    });

    release1();
    const rHigh1 = await pHigh1;
    rHigh1();
    const rHigh2 = await pHigh2;
    rHigh2();
    const rNormal1 = await pNormal1;
    rNormal1();
    await pNormal2;

    expect(order).toEqual(["high1", "high2", "normal1", "normal2"]);
  });

  it("aborting a queued high waiter does not affect normal waiters' order", async () => {
    const limiter = createLimiter(1);
    const release1 = await limiter.acquire();

    const controller = new AbortController();
    const order: string[] = [];
    const pHigh = limiter.acquire(controller.signal, { priority: "high" });
    const pNormal1 = limiter.acquire().then((r) => {
      order.push("normal1");
      return r;
    });
    const pNormal2 = limiter.acquire().then((r) => {
      order.push("normal2");
      return r;
    });
    expect(limiter.waiting).toBe(3);
    expect(limiter.waitingHigh).toBe(1);

    controller.abort();
    await expect(pHigh).rejects.toMatchObject({ name: "AbortError" });
    expect(limiter.waitingHigh).toBe(0);
    expect(limiter.waiting).toBe(2);

    release1();
    const rNormal1 = await pNormal1;
    rNormal1();
    await pNormal2;
    expect(order).toEqual(["normal1", "normal2"]);
  });

  it("default priority is normal, keeping the existing call signature working", async () => {
    const limiter = createLimiter(1);
    const release1 = await limiter.acquire();
    const pDefault = limiter.acquire();
    expect(limiter.waitingHigh).toBe(0);
    expect(limiter.waiting).toBe(1);
    release1();
    await pDefault;
  });
});
