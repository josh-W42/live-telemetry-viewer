import type { RunResult, Sample } from "./metrics";

export interface Summary {
  mode: RunResult["mode"];
  status: RunResult["status"];
  reason: string | null;
  durationMs: number;
  /** When the run first misbehaved, or null if it never did. */
  timeToBreakMs: number | null;
  fps: { p50: number; p95: number; min: number };
  heapMB: { start: number; peak: number; end: number } | null;
  longTasks: { count: number; maxMs: number };
  points: { held: number; rendered: number };
  /**
   * How much of the main thread the renderer consumed. peakBusyPercent is the
   * headline: at 100 the thread did nothing but re-render.
   *
   * The three `atPeak` figures describe the single busiest second, and exist to
   * make it attributable. A run that costs more than another either ran more
   * renders or ran slower ones, and `peakMsPerSec` alone cannot tell you which.
   */
  push: {
    peakMsPerSec: number;
    maxSingleMs: number;
    peakBusyPercent: number;
    /** Renders in the busiest second. */
    rendersAtPeak: number;
    /** Mean milliseconds per render in that second. */
    meanMsAtPeak: number;
    /** The most renders any single second carried. */
    peakRendersPerSec: number;
  };
  /** True if the page was ever hidden, which makes every fps figure worthless. */
  visibilityLost: boolean;
}

/**
 * Nearest-rank percentile: returns an value that actually occurred rather than
 * interpolating between two. For fps that matters - a reported p50 of 41.5 that
 * no sample ever recorded invites more questions than it answers.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index]!;
}

/**
 * The timestamp of the first sample that looked broken.
 *
 * Reported independently of the stop decision because degradation starts before
 * the run is halted: fps must be low for three consecutive samples to fail, but
 * the interesting moment is the first of those three.
 */
function firstBadSample(run: RunResult): number | null {
  if (run.status !== "failed") return null;

  const bad = run.samples.find((s) => s.maxLongTaskMs > 0 && s.fps < 10) ?? run.samples.find((s) => s.fps < 10);
  return bad?.t ?? null;
}

export function summarize(run: RunResult): Summary {
  const { samples } = run;
  const last = samples.at(-1);
  const busiest = busiestSample(samples);

  const fpsValues = samples.map((s) => s.fps);
  const heapValues = samples
    .map((s) => s.heapMB)
    .filter((h): h is number => typeof h === "number");

  return {
    mode: run.mode,
    status: run.status,
    reason: run.reason,
    durationMs: last?.t ?? 0,
    timeToBreakMs: firstBadSample(run),
    fps: {
      p50: round(percentile(fpsValues, 50)),
      p95: round(percentile(fpsValues, 95)),
      min: fpsValues.length ? round(Math.min(...fpsValues)) : 0,
    },
    heapMB: heapValues.length
      ? {
          start: round(heapValues[0]!),
          peak: round(Math.max(...heapValues)),
          end: round(heapValues[heapValues.length - 1]!),
        }
      : null,
    longTasks: {
      count: last?.longTasks ?? 0,
      maxMs: round(last?.maxLongTaskMs ?? 0),
    },
    points: {
      held: peakOf(samples, (s) => s.pointsHeld),
      rendered: peakOf(samples, (s) => s.pointsRendered),
    },
    push: {
      peakMsPerSec: round(peakOf(samples, (s) => s.pushMsTotal)),
      maxSingleMs: round(peakOf(samples, (s) => s.maxPushMs)),
      // Samples are one second apart, so ms spent per sample is already a
      // percentage of that second.
      peakBusyPercent: round(Math.min(peakOf(samples, (s) => s.pushMsTotal) / 10, 100)),
      rendersAtPeak: busiest?.renders ?? 0,
      meanMsAtPeak:
        busiest && busiest.renders > 0 ? round2(busiest.pushMsTotal / busiest.renders) : 0,
      peakRendersPerSec: peakOf(samples, (s) => s.renders),
    },
    visibilityLost: samples.some((s) => !s.visible),
  };
}

/**
 * The sample that spent the most main-thread time.
 *
 * Deliberately the whole sample rather than the maximum of one field: the point
 * is to read several figures off the *same* second, so they describe one
 * moment rather than three unrelated ones.
 */
function busiestSample(samples: Sample[]): Sample | null {
  let worst: Sample | null = null;
  for (const s of samples) {
    if (worst === null || s.pushMsTotal > worst.pushMsTotal) worst = s;
  }
  return worst;
}

function peakOf(samples: Sample[], pick: (s: Sample) => number): number {
  return samples.reduce((max, s) => Math.max(max, pick(s)), 0);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Two places, for per-render costs where a tenth of a millisecond is coarse. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The full run as JSON, for pasting into NOTES.md alongside the summary. */
export function toJSON(run: RunResult): string {
  return JSON.stringify({ summary: summarize(run), samples: run.samples }, null, 2);
}

/** Offers the run as a file download. */
export function downloadReport(run: RunResult): void {
  const blob = new Blob([toJSON(run)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `telemetry-bench-${run.mode}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();

  URL.revokeObjectURL(url);
}
