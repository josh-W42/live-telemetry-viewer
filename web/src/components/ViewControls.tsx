import { ToggleGroup } from "radix-ui";

import { WINDOW_SIZES } from "../store/viewSlice";

/**
 * Pause, window size, jump to live.
 *
 * "Live" and "paused" are one state in the store — a window either follows the
 * clock or it does not — so this reads a single boolean rather than trying to
 * keep two in step. Zooming pins the window, which is why the pause button can
 * come back reading "Resume" without anyone having pressed pause.
 */
export interface ViewControlsProps {
  isLive: boolean;
  durationMs: number;
  onPause: () => void;
  onResume: () => void;
  onWindowSize: (ms: number) => void;
}

export function ViewControls({
  isLive,
  durationMs,
  onPause,
  onResume,
  onWindowSize,
}: ViewControlsProps) {
  return (
    <section className="row" aria-label="view controls">
      <button
        type="button"
        className="btn"
        data-variant={isLive ? undefined : "warn"}
        onClick={isLive ? onPause : onResume}
      >
        {isLive ? "❚❚ Pause" : "▶ Resume"}
      </button>

      <ToggleGroup.Root
        className="toggle-group"
        type="single"
        aria-label="window size"
        // A pinned window has a span of its own that matches no preset, so
        // nothing is selected until the view follows the clock again.
        value={isLive ? String(durationMs) : ""}
        onValueChange={(v) => v && onWindowSize(Number(v))}
      >
        {WINDOW_SIZES.map((w) => (
          <ToggleGroup.Item key={w.ms} className="toggle" value={String(w.ms)}>
            {w.label}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>

      <button type="button" className="btn" onClick={onResume} disabled={isLive}>
        Jump to live
      </button>

      <span className="dim">
        {isLive
          ? "following live · scroll to zoom, drag to pan"
          : "paused · ingestion continues"}
      </span>
    </section>
  );
}
