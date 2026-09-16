import { lttb } from "../lib/lttb";
import type { ChannelMeta, ChannelView } from "./protocol";
import type { RingBuffer } from "./ringbuffer";

/**
 * Turn the retained samples into what the chart should draw.
 *
 * Lives here rather than inside the worker entry point so it can be tested
 * without a worker: it is where channel visibility is applied and where the two
 * point counts are decided, and both of those are claims the status bar makes
 * on screen.
 */
export interface BuiltView {
  channels: ChannelView[];
  /** Samples retained across **every** buffer, visible or not. */
  pointsHeld: number;
  /** Samples returned after filtering and downsampling. */
  pointsRendered: number;
}

export interface ViewSpec {
  startNs: bigint;
  endNs: bigint;
  maxPoints: number;
  /** `null` means every channel; `[]` means none. */
  channelIds: string[] | null;
}

export function buildView(
  channels: readonly ChannelMeta[],
  buffers: ReadonlyMap<string, RingBuffer>,
  spec: ViewSpec,
): BuiltView {
  // Retention is a property of the buffers, not of the view, so this counts
  // every channel whether or not it was asked for. A hidden channel keeps
  // filling — that is the whole reason visibility is applied here rather than
  // at the subscription, where narrowing would restart the stream and throw the
  // ring buffers away.
  let pointsHeld = 0;
  for (const buf of buffers.values()) pointsHeld += buf.length;

  const wanted = spec.channelIds === null ? null : new Set(spec.channelIds);

  const views: ChannelView[] = [];
  let pointsRendered = 0;

  for (const channel of channels) {
    if (wanted !== null && !wanted.has(channel.id)) continue;

    const buf = buffers.get(channel.id);
    if (!buf) continue;

    const slice = buf.sliceByTime(spec.startNs, spec.endNs);
    const reduced = lttb(slice.timestamps, slice.values, spec.maxPoints);

    pointsRendered += reduced.values.length;
    views.push({
      channelId: channel.id,
      timestamps: reduced.timestamps,
      values: reduced.values,
    });
  }

  return { channels: views, pointsHeld, pointsRendered };
}
