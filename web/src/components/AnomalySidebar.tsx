import type { Anomaly } from "../worker/rules";
import { colorFor } from "../render/types";

/**
 * Anomalies newest first, clicking one jumps the view to it.
 *
 * The list arrives whole on the worker's 2 Hz stats message and replaces what
 * the store held, so an open excursion's duration and peak update in place
 * without any merge logic that could drift out of step with the chart.
 */
export interface AnomalySidebarProps {
  anomalies: Anomaly[];
  onShow: (anomaly: Anomaly) => void;
}

export function AnomalySidebar({ anomalies, onShow }: AnomalySidebarProps) {
  return (
    <div className="panel">
      <div className="panel-title">
        <span>anomalies</span>
        <span>{anomalies.length}</span>
      </div>

      {anomalies.length === 0 ? (
        <p className="dim">
          none yet — the rig injects a fault on each channel occasionally, so a
          steady-state phase or two may pass without one
        </p>
      ) : (
        <ul className="anomaly-list">
          {anomalies.map((a) => (
            <li key={a.id}>
              <button type="button" className="anomaly" onClick={() => onShow(a)}>
                <span className="anomaly-swatch" style={{ background: colorFor(a.channelId) }} />
                <span className="anomaly-label">
                  {a.label}
                  {a.open && <em className="anomaly-open"> ongoing</em>}
                </span>
                <span className="dim">
                  {new Date(a.startMs).toLocaleTimeString()} ·{" "}
                  {Math.round(a.endMs - a.startMs)} ms · peak {a.peak.toFixed(1)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
