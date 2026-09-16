import { Tooltip } from "radix-ui";

import type { ConnectionStatus } from "../render/types";

/**
 * The status bar SPEC.md asks for: connection state, points held, points
 * rendered, render fps, dropped batches.
 *
 * The first two and the last three are not decoration. "Points held" against
 * "points rendered" is the entire M3 argument on screen — held climbs to 2.4M
 * and stops, rendered sits near twice the chart's pixel width and never moves —
 * so each metric carries a tooltip saying what it means and why it is here.
 */
export interface StatusBarProps {
  connection: ConnectionStatus;
  pointsHeld: number;
  pointsRendered: number;
  fps: number;
  /** Times a second the chart was handed new data. */
  rendersPerSec: number;
  droppedBatches: number;
  heapMB: number | null;
  /** Bytes the worker's ring buffers occupy. Fixed once allocated. */
  bufferBytes: number;
}

export function StatusBar({
  connection,
  pointsHeld,
  pointsRendered,
  fps,
  rendersPerSec,
  droppedBatches,
  heapMB,
  bufferBytes,
}: StatusBarProps) {
  return (
    <section className="status-bar" aria-label="status">
      <Metric
        label="connection"
        hint={
          "An idle or hidden page holds no subscription — the stream is torn down " +
          "rather than left running at 4,000 samples a second for nobody."
        }
      >
        <span className="conn" data-state={connection.state}>
          <span className="conn-dot" />
          {connection.state === "error" ? "error" : connection.state}
        </span>
      </Metric>

      <Metric
        label="points held"
        hint={
          "Samples retained across the four ring buffers. Climbs to 2.4M — ten " +
          "minutes at 1 kHz — and then stops, because the buffers are allocated " +
          "once and overwrite their oldest samples."
        }
      >
        {pointsHeld.toLocaleString()}
      </Metric>

      <Metric
        label="points rendered"
        hint={
          "Points actually handed to ECharts, after LTTB. Bounded by the display " +
          "at roughly 2 per pixel per visible channel, not by how much data is " +
          "held — which is why holding more costs only memory."
        }
      >
        {pointsRendered.toLocaleString()}
      </Metric>

      <Metric
        label="render fps"
        hint={
          "Measured from animation frame intervals over the last second. Reads 0 " +
          "when the window is occluded, since a window nobody can see schedules " +
          "no frames."
        }
        warn={connection.state === "streaming" && fps > 0 && fps < 20}
      >
        {fps > 0 ? String(Math.round(fps)) : "—"}
      </Metric>

      <Metric
        label="renders/s"
        hint={
          "How often the chart is handed new data. Not the same as the frame rate " +
          "beside it: the view loop asks at most about 30 times a second, and holds " +
          "only one request open at a time, so this also reports how fast the worker " +
          "answers. A number well below 30 means the round trip is the limit, not the " +
          "throttle. It is what makes render cost attributable — twice the main-thread " +
          "time means either slower renders or more of them, and one figure cannot say " +
          "which."
        }
      >
        {rendersPerSec > 0 ? String(Math.round(rendersPerSec)) : "—"}
      </Metric>

      <Metric
        label="dropped batches"
        hint={
          "Batches the server sent that never arrived, counted from gaps in the " +
          "sequence number. The broadcaster drops a slow subscriber's oldest " +
          "queued batch rather than blocking the simulator, and this is what " +
          "makes that visible."
        }
        warn={droppedBatches > 0}
      >
        {droppedBatches.toLocaleString()}
      </Metric>

      <Metric
        label="heap MB"
        hint={
          bufferBytes > 0
            ? `JS heap in use. The ring buffers account for a fixed ${(
                bufferBytes / 1048576
              ).toFixed(1)} MB of it, packed as Float64Array and never reallocated.`
            : "JS heap in use, from the non-standard performance.memory. A coarse estimate."
        }
      >
        {heapMB === null ? "—" : String(Math.round(heapMB))}
      </Metric>
    </section>
  );
}

function Metric({
  label,
  hint,
  warn,
  children,
}: {
  label: string;
  hint: string;
  warn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip.Root>
      {/*
        A button, not a div, because a tooltip that only appears on hover is
        unreachable by keyboard. Radix gives it the focus and Escape handling;
        the cursor is set to `help` so it does not read as an action.
      */}
      <Tooltip.Trigger asChild>
        <button type="button" className="stat">
          <span className="stat-label">{label}</span>
          <div className="stat-value" data-warn={warn ? "true" : undefined}>
            {children}
          </div>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6} collisionPadding={8}>
          {hint}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
