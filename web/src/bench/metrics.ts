// Benchmark instrumentation.
//
// This module is deliberately independent of how the chart renders. M2 measures
// two naive renderers and M3 measures a worker-backed one, and the comparison
// between them is only meaningful if the measurement is identical. Anything
// renderer-specific belongs behind the ChartRenderer interface, not here.

/** One second of observation. */
export interface Sample {
  /** Milliseconds since the run started. */
  t: number;
  fps: number;
  /** Null where the browser does not expose a heap reading. */
  heapMB: number | null;
  /** Long tasks observed so far, cumulative. */
  longTasks: number;
  /** Longest single long task so far, in milliseconds. */
  maxLongTaskMs: number;
  /** Points the renderer is holding in memory. */
  pointsHeld: number;
  /** Points actually handed to the chart. */
  pointsRendered: number;
  batches: number;
  gaps: number;
  /**
   * Whether the page was visible for this sample. A hidden tab runs no
   * animation frames, so fps reads 0 no matter how healthy the renderer is.
   */
  visible: boolean;
  /**
   * Animation frames observed during this sample.
   *
   * Distinct from fps because zero frames is qualitatively different from slow
   * frames: it means nothing was painted at all, which an occluded window
   * produces even while the Page Visibility API still reports "visible".
   */
  frames: number;
  /** Main-thread milliseconds spent inside renderer.push during this second. */
  pushMsTotal: number;
  /** Longest single push during this second. */
  maxPushMs: number;
}

/**
 * "invalid" means the run measured nothing meaningful - almost always because
 * the tab was hidden - and is deliberately distinct from "failed", which is a
 * real result.
 */
export type RunStatus = "running" | "completed" | "failed" | "invalid";

export type RenderMode = "naive" | "append" | "worker";

export interface StopConfig {
  durationMs: number;
  /** Frames per second below which the run is considered broken. */
  minFps: number;
  /** How many consecutive samples must be below minFps before failing. */
  minFpsSamples: number;
  /** A single task longer than this fails the run outright. */
  maxLongTaskMs: number;
}

export const defaultStopConfig: StopConfig = {
  durationMs: 10 * 60 * 1000,
  minFps: 10,
  minFpsSamples: 3,
  maxLongTaskMs: 2000,
};

export interface RunResult {
  mode: RenderMode;
  status: RunStatus;
  reason: string | null;
  startedAt: number;
  endedAt: number | null;
  samples: Sample[];
}

/**
 * fps from a list of frame timestamps.
 *
 * Measured as intervals rather than frame count: n timestamps describe n-1
 * intervals, and dividing by the elapsed span gives the average rate over the
 * window even when frames are unevenly spaced.
 */
export function fpsFromFrameTimes(times: number[]): number {
  if (times.length < 2) return 0;

  const first = times[0]!;
  const last = times[times.length - 1]!;
  const elapsedSec = (last - first) / 1000;
  if (elapsedSec <= 0) return 0;

  return (times.length - 1) / elapsedSec;
}

/** Shape of the non-standard, Chromium-only performance.memory. */
interface MemoryLike {
  memory?: { usedJSHeapSize: number };
}

/**
 * Current JS heap usage in megabytes, or null where unavailable.
 *
 * performance.memory is non-standard and Chromium-only, and it reports a coarse
 * estimate rather than an exact figure. It is good enough for a before/after
 * comparison on one machine, which is all this is used for.
 */
export function readHeapMB(perf: MemoryLike): number | null {
  try {
    const used = perf.memory?.usedJSHeapSize;
    if (typeof used !== "number") return null;
    return used / 1048576;
  } catch {
    // Some environments throw on access rather than leaving it undefined.
    return null;
  }
}

export interface StopDecision {
  stop: boolean;
  status: RunStatus;
  reason: string | null;
}

/**
 * Decide whether a run should end, given everything observed so far.
 *
 * Pure, so the thresholds can be tested without waiting ten minutes for a real
 * run to degrade.
 */
export function evaluateStop(samples: Sample[], cfg: StopConfig): StopDecision {
  const latest = samples[samples.length - 1];
  if (!latest) return { stop: false, status: "running", reason: null };

  // Checked before everything else: a run that lost visibility has not measured
  // a slow renderer, it has measured nothing. Reporting that as a failure would
  // put a fabricated number in the write-up.
  if (samples.some((s) => !s.visible)) {
    return {
      stop: true,
      status: "invalid",
      reason: "page was hidden during the run; no animation frames were scheduled",
    };
  }

  // Zero frames with an idle main thread means the page is not being painted
  // at all — an occluded or backgrounded window. `document.hidden` does not
  // catch this: a pane hidden behind another in a desktop app stays "visible"
  // to the page while the compositor stops scheduling frames. Reporting that
  // as an fps failure would put an invented number in the write-up.
  //
  // A genuinely frozen renderer also produces no frames, but it is never idle
  // while doing so, which is what separates the two.
  const recentFrameless = samples.slice(-cfg.minFpsSamples);
  if (
    recentFrameless.length === cfg.minFpsSamples &&
    recentFrameless.every((s) => s.frames === 0 && s.pushMsTotal < 100 && s.maxLongTaskMs === 0)
  ) {
    return {
      stop: true,
      status: "invalid",
      reason:
        "no animation frames were scheduled while the main thread sat idle; " +
        "the window is probably occluded",
    };
  }

  // A failure is more informative than a completion, so it is checked first and
  // wins if both conditions land on the same sample.
  if (latest.maxLongTaskMs > cfg.maxLongTaskMs) {
    return {
      stop: true,
      status: "failed",
      reason: `long task of ${Math.round(latest.maxLongTaskMs)}ms exceeded ${cfg.maxLongTaskMs}ms`,
    };
  }

  const recent = samples.slice(-cfg.minFpsSamples);
  if (recent.length === cfg.minFpsSamples && recent.every((s) => s.fps < cfg.minFps)) {
    return {
      stop: true,
      status: "failed",
      reason: `fps below ${cfg.minFps} for ${cfg.minFpsSamples} consecutive samples`,
    };
  }

  if (latest.t >= cfg.durationMs) {
    return { stop: true, status: "completed", reason: null };
  }

  return { stop: false, status: "running", reason: null };
}

/** Counters the harness reads from the rest of the app each sample. */
export interface CounterSource {
  pointsHeld(): number;
  pointsRendered(): number;
  batches(): number;
  gaps(): number;
  /**
   * Time spent inside renderer.push since the last call, and the longest single
   * push, in milliseconds. Reading resets the accumulator.
   *
   * This is the most direct measure of what the renderer costs. fps is an
   * indirect symptom, and it is unavailable in a hidden tab, whereas this is a
   * plain stopwatch around the work itself.
   */
  takePushStats(): { totalMs: number; maxMs: number };
}

/**
 * Collects samples once a second until a stop condition trips.
 *
 * Owns three browser-side observations: frame timestamps via
 * requestAnimationFrame, heap via performance.memory, and freezes via a
 * longtask PerformanceObserver. Long tasks are the important one — fps alone
 * understates a stall, because a thread blocked for two seconds simply stops
 * producing frames rather than producing slow ones.
 */
export class BenchRun {
  private frameTimes: number[] = [];
  private rafHandle = 0;
  private observer: PerformanceObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private longTasks = 0;
  private maxLongTaskMs = 0;
  private startedAt = 0;

  readonly samples: Sample[] = [];
  status: RunStatus = "running";
  reason: string | null = null;

  constructor(
    readonly mode: RenderMode,
    private readonly counters: CounterSource,
    private readonly cfg: StopConfig = defaultStopConfig,
    private readonly onUpdate?: (run: BenchRun) => void,
  ) {}

  /**
   * True when the page can actually be measured. Refusing to start beats
   * producing a run full of zeroes that looks like a catastrophic result.
   */
  static canMeasure(): boolean {
    return typeof document === "undefined" || !document.hidden;
  }

  start(): void {
    if (!BenchRun.canMeasure()) {
      this.status = "invalid";
      this.reason = "page is hidden; bring the window to the foreground and re-run";
      this.onUpdate?.(this);
      return;
    }

    this.startedAt = performance.now();

    const tick = (now: number) => {
      this.frameTimes.push(now);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);

    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks += 1;
          this.maxLongTaskMs = Math.max(this.maxLongTaskMs, entry.duration);
        }
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Not supported everywhere; the run still records fps and heap.
      this.observer = null;
    }

    this.timer = setInterval(() => this.sample(), 1000);
  }

  private sample(): void {
    const push = this.counters.takePushStats();
    const sample: Sample = {
      t: performance.now() - this.startedAt,
      fps: fpsFromFrameTimes(this.frameTimes),
      heapMB: readHeapMB(performance as MemoryLike),
      longTasks: this.longTasks,
      maxLongTaskMs: this.maxLongTaskMs,
      pointsHeld: this.counters.pointsHeld(),
      pointsRendered: this.counters.pointsRendered(),
      batches: this.counters.batches(),
      gaps: this.counters.gaps(),
      visible: typeof document === "undefined" || !document.hidden,
      frames: this.frameTimes.length,
      pushMsTotal: push.totalMs,
      maxPushMs: push.maxMs,
    };
    this.frameTimes = [];
    this.samples.push(sample);

    const decision = evaluateStop(this.samples, this.cfg);
    if (decision.stop) {
      this.status = decision.status;
      this.reason = decision.reason;
      this.stop();
    }

    this.onUpdate?.(this);
  }

  /**
   * End the run as `invalid` — it measured nothing usable.
   *
   * Exists because the per-sample checks cannot be relied on to notice in time.
   * The sampler is a main-thread `setInterval`, which browsers throttle to once
   * a minute in a background tab and may freeze entirely, so a run that becomes
   * unmeasurable needs to be told rather than left to find out.
   */
  invalidate(reason: string): void {
    if (this.status !== "running") return;

    this.status = "invalid";
    this.reason = reason;
    this.stop();
    this.onUpdate?.(this);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Guarded because a run can be stopped or invalidated before it ever
    // started — including outside a browser, which is how this is unit tested.
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.rafHandle);
    this.observer?.disconnect();
    this.observer = null;

    if (this.status === "running") this.status = "completed";
  }

  result(): RunResult {
    return {
      mode: this.mode,
      status: this.status,
      reason: this.reason,
      startedAt: this.startedAt,
      endedAt: this.samples.at(-1)?.t ?? null,
      samples: [...this.samples],
    };
  }
}
