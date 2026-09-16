import { Checkbox } from "radix-ui";

import type { Channel } from "../gen/telemetry/v1/telemetry_pb";
import { colorFor } from "../render/types";

/**
 * Channel toggles.
 *
 * Unticking a channel narrows the *view request*, not the subscription. The
 * worker stops slicing and downsampling that channel — so "points rendered"
 * falls — while its ring buffer keeps filling and its rules keep running. Tick
 * it back on and the whole retained history is there, including any anomaly
 * found while it was hidden.
 */
export interface ChannelListProps {
  channels: Channel[];
  /** Ids currently drawn. */
  visible: string[];
  /** Retained samples per channel, keyed by id. */
  heldPerChannel: Record<string, number>;
  onToggle: (channelId: string) => void;
}

export function ChannelList({ channels, visible, heldPerChannel, onToggle }: ChannelListProps) {
  const shown = new Set(visible);

  return (
    <div className="panel">
      <div className="panel-title">
        <span>channels</span>
        <span>
          {visible.length}/{channels.length}
        </span>
      </div>

      <ul className="channel-list">
        {channels.map((c) => {
          const isVisible = shown.has(c.id);
          const held = heldPerChannel[c.id] ?? 0;

          return (
            <li key={c.id}>
              <label className="channel" data-hidden={isVisible ? undefined : "true"}>
                <Checkbox.Root
                  className="checkbox"
                  checked={isVisible}
                  onCheckedChange={() => onToggle(c.id)}
                >
                  <Checkbox.Indicator className="checkbox-indicator">
                    <CheckMark />
                  </Checkbox.Indicator>
                </Checkbox.Root>

                <span className="swatch" style={{ background: colorFor(c.id) }} />
                <span className="channel-name">
                  {c.name} <span className="dim">{c.unit}</span>
                </span>
                {/*
                  Held, not rendered: the count keeps climbing while a channel is
                  unticked, which is the whole point of filtering the view rather
                  than the subscription.
                */}
                <span className="channel-count">{held.toLocaleString()}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M1.5 5.2 4 7.6 8.5 2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
