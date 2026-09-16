import { Checkbox, Collapsible, ToggleGroup } from "radix-ui";

import type { RenderMode } from "../bench/metrics";
import type { Summary } from "../bench/report";

/**
 * The M2/M3 benchmark harness, folded away.
 *
 * It used to be the page. It is kept, reachable and unchanged, because every
 * number in NOTES.md was produced by it and has to stay reproducible — but the
 * naive modes exist to be measured, not used, so the viewer is what opens.
 */
export const MODES: { id: RenderMode; label: string; blurb: string }[] = [
  { id: "naive", label: "A · naive setOption", blurb: "Whole dataset re-sent every batch" },
  { id: "append", label: "B · appendData", blurb: "Only new points, axis moved 1×/s" },
  { id: "worker", label: "C · worker + LTTB", blurb: "Ring buffers and downsampling off-thread" },
  {
    id: "worker-svg",
    label: "C-svg · same, SVG backend",
    blurb: "Mode C with ECharts' SVG renderer instead of canvas",
  },
];

export interface BenchPanelProps {
  mode: RenderMode;
  onModeChange: (mode: RenderMode) => void;
  running: boolean;
  onRun: (durationMs: number) => void;
  onStop: () => void;
  onDownload: () => void;
  hasResult: boolean;
  summary: Summary | null;
  /**
   * Modes A and B stream only when asked. Feeding a naive renderer
   * continuously degrades the page to unusability within minutes, and would
   * leave each run starting from whatever the last one left behind.
   */
  previewWhenIdle: boolean;
  onPreviewChange: (on: boolean) => void;
}

export function BenchPanel({
  mode,
  onModeChange,
  running,
  onRun,
  onStop,
  onDownload,
  hasResult,
  summary,
  previewWhenIdle,
  onPreviewChange,
}: BenchPanelProps) {
  const isBaseline = mode === "naive" || mode === "append";

  return (
    <Collapsible.Root className="collapsible">
      <Collapsible.Trigger className="collapsible-trigger">
        <span className="collapsible-chevron" aria-hidden="true">
          ▸
        </span>
        Benchmarks — render modes and measured runs
      </Collapsible.Trigger>

      <Collapsible.Content className="collapsible-content">
        <p className="dim" style={{ margin: 0 }}>
          Modes A and B are the M2 baselines. They saturate the main thread at about 85,600
          points and are here so the comparison in NOTES.md can be re-run rather than trusted.
        </p>

        <ToggleGroup.Root
          className="toggle-group"
          type="single"
          aria-label="render mode"
          value={mode}
          onValueChange={(v) => v && onModeChange(v as RenderMode)}
          disabled={running}
        >
          {MODES.map((m) => (
            <ToggleGroup.Item key={m.id} className="toggle" value={m.id} title={m.blurb}>
              {m.label}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>

        <div className="row">
          <button type="button" className="btn" onClick={() => onRun(60_000)} disabled={running}>
            Run 1 min
          </button>
          <button type="button" className="btn" onClick={() => onRun(600_000)} disabled={running}>
            Run 10 min
          </button>
          <button type="button" className="btn" onClick={onStop} disabled={!running}>
            Stop
          </button>
          <button type="button" className="btn" onClick={onDownload} disabled={!hasResult}>
            Download JSON
          </button>

          {isBaseline && (
            <label className="channel" style={{ gridTemplateColumns: "auto 1fr" }}>
              <Checkbox.Root
                className="checkbox"
                checked={previewWhenIdle}
                disabled={running}
                onCheckedChange={(v) => onPreviewChange(v === true)}
              >
                <Checkbox.Indicator className="checkbox-indicator">✓</Checkbox.Indicator>
              </Checkbox.Root>
              <span className="dim">feed this baseline when idle</span>
            </label>
          )}
        </div>

        <p className="dim" style={{ margin: 0 }}>
          Do not interact with the page while a run is in progress: it executes on the very
          thread being measured. Leave the window in front — an occluded window schedules no
          frames, and the run is marked invalid rather than failed.
        </p>

        {summary && (
          <div className="bench-summary">
            <strong>
              {summary.mode} — {summary.status}
              {summary.reason ? `: ${summary.reason}` : ""}
            </strong>
            <pre>{JSON.stringify(summary, null, 2)}</pre>
          </div>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
