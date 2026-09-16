import { describe, expect, it } from "vitest";

import { RenderTimer } from "./types";

/** Burn enough wall clock that the timer records something above zero. */
function slowly(ms = 1): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

describe("RenderTimer", () => {
  it("starts empty", () => {
    const timer = new RenderTimer();
    expect(timer.take()).toEqual({ totalMs: 0, maxMs: 0, count: 0 });
    expect(timer.renderCount()).toBe(0);
  });

  it("returns whatever the measured function returns", () => {
    const timer = new RenderTimer();
    expect(timer.measure(() => 42)).toBe(42);
  });

  it("counts renders as well as timing them", () => {
    const timer = new RenderTimer();
    for (let i = 0; i < 3; i++) timer.measure(() => slowly());

    const stats = timer.take();
    expect(stats.count).toBe(3);
    expect(stats.totalMs).toBeGreaterThan(0);
    expect(stats.maxMs).toBeGreaterThan(0);
    expect(stats.totalMs).toBeGreaterThanOrEqual(stats.maxMs);
  });

  it("resets the count along with the timings", () => {
    const timer = new RenderTimer();
    timer.measure(() => slowly());
    timer.take();

    expect(timer.take()).toEqual({ totalMs: 0, maxMs: 0, count: 0 });
  });

  // Still counts a render that threw, because the thread spent the time either
  // way and a metric that under-reports on failure is worse than none.
  it("counts and times a render that throws", () => {
    const timer = new RenderTimer();
    expect(() =>
      timer.measure(() => {
        slowly();
        throw new Error("setOption blew up");
      }),
    ).toThrow("setOption blew up");

    const stats = timer.take();
    expect(stats.count).toBe(1);
    expect(stats.totalMs).toBeGreaterThan(0);
  });

  /*
  The reason there are two counters rather than one.

  `take()` is destructive, and the status bar and the benchmark harness both
  want to know the render rate. If they shared the resetting accumulator,
  whichever polled first would silently consume the other's data and the run
  would report a fraction of the work it actually did — the same class of
  self-inflicted measurement error as reading results mid-run.
  */
  describe("the lifetime count", () => {
    it("is not disturbed by taking the resettable stats", () => {
      const timer = new RenderTimer();
      for (let i = 0; i < 5; i++) timer.measure(() => undefined);

      timer.take();
      timer.take();

      expect(timer.renderCount()).toBe(5);
    });

    it("keeps accumulating across takes", () => {
      const timer = new RenderTimer();

      timer.measure(() => undefined);
      expect(timer.take().count).toBe(1);

      timer.measure(() => undefined);
      timer.measure(() => undefined);
      expect(timer.take().count).toBe(2);

      expect(timer.renderCount()).toBe(3);
    });

    it("never goes backwards, so a rate differenced from it cannot go negative", () => {
      const timer = new RenderTimer();
      let previous = timer.renderCount();

      for (let i = 0; i < 10; i++) {
        timer.measure(() => undefined);
        if (i % 3 === 0) timer.take();

        const now = timer.renderCount();
        expect(now).toBeGreaterThanOrEqual(previous);
        previous = now;
      }
    });
  });
});
