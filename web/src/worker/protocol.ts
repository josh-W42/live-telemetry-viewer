/**
 * Messages between the main thread and the telemetry worker.
 *
 * Nanosecond timestamps cross as BigInt, which structured clone handles
 * natively, so there is no string encoding to get wrong.
 */

import type { Anomaly } from "./rules";

export interface ChannelMeta {
  id: string;
  name: string;
  unit: string;
  sampleRateHz: number;
}

/** Open the stream and start filling ring buffers. */
export interface StartRequest {
  type: "start";
  baseUrl: string;
  /** Samples retained per channel. 10 minutes at 1kHz is 600_000. */
  capacity: number;
  /** Empty means every channel. */
  channelIds: string[];
}

/** Ask for a downsampled window. */
export interface ViewRequest {
  type: "view";
  /** Correlates the response, so a stale reply can be discarded. */
  id: number;
  startNs: bigint;
  endNs: bigint;
  /** Roughly twice the chart's pixel width. */
  maxPoints: number;
  /**
   * Channels to return. `null` means every channel; `[]` means none.
   *
   * Nullable rather than following `StartRequest`'s empty-means-all
   * convention, because here the two genuinely differ: hiding every channel is
   * a legitimate thing to ask for, and an empty array that meant "all" would
   * answer it with the exact opposite.
   *
   * This is where channel visibility is applied, and deliberately not at the
   * subscription: narrowing `StartRequest.channelIds` would restart the stream
   * and discard the ring buffers, so unticking a channel would destroy its
   * history. Filtering here leaves ingestion and rule evaluation untouched —
   * a hidden channel keeps filling and keeps being checked for faults — while
   * still sparing the worker the slice and the downsample.
   */
  channelIds: string[] | null;
}

/**
 * Ask for counters only.
 *
 * Separate from a view because it costs nothing: no slicing, no downsampling.
 * It lets the UI show live progress before the first view succeeds, and makes
 * the ring buffers observable without rendering anything.
 */
export interface StatsRequest {
  type: "stats";
}

export interface StopRequest {
  type: "stop";
}

export type WorkerRequest = StartRequest | ViewRequest | StatsRequest | StopRequest;

export interface ChannelView {
  channelId: string;
  /** Nanosecond offsets from baseNs. */
  timestamps: Float64Array;
  values: Float64Array;
}

export interface ReadyMessage {
  type: "ready";
  channels: ChannelMeta[];
  baseNs: bigint;
}

export interface ViewMessage {
  type: "view";
  id: number;
  baseNs: bigint;
  channels: ChannelView[];
  /** Samples retained across all ring buffers. */
  pointsHeld: number;
  /** Samples actually returned after downsampling. */
  pointsRendered: number;
  batches: number;
  droppedBatches: number;
  /** Milliseconds the worker spent slicing and downsampling this view. */
  workerMs: number;
}

export interface StatsMessage {
  type: "stats";
  pointsHeld: number;
  /** Per-channel retained sample counts, keyed by channel id. */
  perChannel: Record<string, number>;
  /** Total bytes across all ring buffers. Constant once allocated. */
  bytes: number;
  batches: number;
  /**
   * Batches the server sent that never arrived, counted from the gaps in
   * `sequence`. A jump from 10 to 15 is four lost batches, not one event —
   * counting the events instead understates a slow client by however many
   * batches each stall swallowed.
   */
  droppedBatches: number;
  /**
   * Every anomaly still inside the retained window, sent whole rather than as
   * deltas. The list is tiny and an open anomaly keeps growing, so replacing
   * wholesale is both cheaper and impossible to desynchronise.
   */
  anomalies: Anomaly[];
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type WorkerMessage = ReadyMessage | ViewMessage | StatsMessage | ErrorMessage;
