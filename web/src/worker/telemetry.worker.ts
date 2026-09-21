/// <reference lib="webworker" />

/**
 * The telemetry worker.
 *
 * It owns the Connect stream, the ring buffers, and downsampling. No raw batch
 * ever reaches the main thread — the main thread only ever sees a few thousand
 * already-downsampled points per view. That is the entire architectural claim
 * of M3, and keeping the stream in here is what makes it true.
 *
 * `@connectrpc/connect-web` is fetch-based with no DOM dependency, so the same
 * generated client used on the main thread runs here unchanged.
 */

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { TelemetryService } from "../gen/telemetry/v1/telemetry_pb";
import { droppedSince } from "../lib/sequence";
import type { ChannelMeta, ViewRequest, WorkerRequest } from "./protocol";
import { RingBuffer } from "./ringbuffer";
import { DEFAULT_RULES, RuleEvaluator } from "./rules";
import { buildView } from "./view";

const ctx = self as DedicatedWorkerGlobalScope;

let buffers = new Map<string, RingBuffer>();
let channels: ChannelMeta[] = [];
let baseNs = 0n;
let abort: AbortController | null = null;

// Rules run on ingestion, so they see every sample - including the 99%+ that
// LTTB drops before drawing, and everything that arrives while paused.
let evaluator = new RuleEvaluator(DEFAULT_RULES);
let retentionMs = 600_000;

let batches = 0;
let droppedBatches = 0;
let lastSequence = 0n;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "start":
      void start(msg.baseUrl, msg.capacity, msg.channelIds, msg.newSession);
      break;
    case "view":
      try {
        respondToView(msg);
      } catch (err) {
        // Surface it to the main thread rather than dying as an uncaught
        // worker exception, which would leave the renderer waiting forever on
        // a reply that never comes.
        ctx.postMessage({ type: "error", message: String(err) });
      }
      break;
    case "stats":
      reportStats();
      break;
    case "stop":
      stop();
      break;
  }
};

/** Counters only: no slicing, no downsampling, so it is safe to call often. */
function reportStats(): void {
  const perChannel: Record<string, number> = {};
  let pointsHeld = 0;
  let bytes = 0;

  for (const [id, buf] of buffers) {
    perChannel[id] = buf.length;
    pointsHeld += buf.length;
    bytes += buf.byteLength;
  }

  const nowNs = BigInt(Date.now()) * 1_000_000n;
  ctx.postMessage({
    type: "stats",
    pointsHeld,
    perChannel,
    bytes,
    batches,
    droppedBatches,
    anomalies: evaluator.anomalies(nowNs, retentionMs),
  });
}

async function start(
  baseUrl: string,
  capacity: number,
  channelIds: string[],
  newSession: boolean,
): Promise<void> {
  stop();

  const transport = createConnectTransport({ baseUrl });
  const client = createClient(TelemetryService, transport);

  // Declared out here so the catch can interrogate this run's controller.
  // A failure before the stream opens leaves it null, which correctly reports.
  let controller: AbortController | null = null;

  try {
    const meta = await client.listChannels({});
    channels = meta.channels
      .filter((c) => channelIds.length === 0 || channelIds.includes(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        unit: c.unit,
        sampleRateHz: c.sampleRateHz,
      }));

    // Fixed once, before any sample arrives, so every offset is measured from
    // the same origin. Early offsets may be slightly negative if the server's
    // clock leads ours; that is harmless, the arithmetic is signed.
    baseNs = BigInt(Date.now()) * 1_000_000n;

    buffers = new Map(channels.map((c) => [c.id, new RingBuffer(capacity, baseNs)]));

    // A fresh run means a fresh buffer, so past anomalies point at samples that
    // no longer exist.
    evaluator = new RuleEvaluator(DEFAULT_RULES);
    // Retention is however long the ring buffer holds at this rate; anomalies
    // are pruned against the same horizon the samples are.
    retentionMs = (capacity / (channels[0]?.sampleRateHz ?? 1000)) * 1000;

    batches = 0;
    droppedBatches = 0;
    lastSequence = 0n;

    ctx.postMessage({ type: "ready", channels, baseNs });

    // Held locally as well as module-wide. The catch below has to ask *this*
    // run's controller whether it was cancelled: `stop()` sets the module-level
    // `abort` to null, and a restart replaces it with a fresh controller, so by
    // the time an aborted stream throws, that variable no longer describes the
    // run that threw.
    controller = new AbortController();
    abort = controller;

    const stream = client.streamTelemetry(
      { channelIds, newSession },
      { signal: controller.signal },
    );

    for await (const batch of stream) {
      droppedBatches += droppedSince(lastSequence, batch.sequence);
      lastSequence = batch.sequence;
      batches += 1;

      for (const ch of batch.channels) {
        buffers.get(ch.channelId)?.push(ch.timestampsNs, ch.values);
        evaluator.push(ch.channelId, ch.timestampsNs, Float64Array.from(ch.values));
      }
    }

    // Falling out of the loop without an error means the server closed the
    // stream. The platform caps a request at 100 minutes, so a long session
    // ends exactly here. Say so; the main thread decides whether to reconnect.
    if (!controller.signal.aborted) {
      ctx.postMessage({ type: "ended" });
    }
  } catch (err) {
    // A cancelled stream is how stopping works, not a failure. Reporting it
    // would fill the console with "[canceled]" on every pause, mode switch and
    // tab change, which is exactly how a real error gets overlooked.
    if (controller?.signal.aborted) return;
    ctx.postMessage({ type: "error", message: String(err) });
  }
}

function stop(): void {
  abort?.abort();
  abort = null;
}

/** Slice, downsample and post one view. The work itself lives in view.ts. */
function respondToView(req: ViewRequest): void {
  const started = performance.now();

  const built = buildView(channels, buffers, req);

  // Every returned array was freshly allocated by LTTB, so the buffers can be
  // transferred rather than copied. Transferring neuters the sender's copy —
  // which is exactly why the ring buffers themselves are never handed over.
  const transfer: ArrayBuffer[] = [];
  for (const v of built.channels) {
    transfer.push(v.timestamps.buffer as ArrayBuffer, v.values.buffer as ArrayBuffer);
  }

  ctx.postMessage(
    {
      type: "view",
      id: req.id,
      baseNs,
      channels: built.channels,
      pointsHeld: built.pointsHeld,
      pointsRendered: built.pointsRendered,
      batches,
      droppedBatches,
      workerMs: performance.now() - started,
    },
    transfer,
  );
}
