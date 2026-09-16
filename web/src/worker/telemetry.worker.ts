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
import { lttb } from "../lib/lttb";
import type {
  ChannelMeta,
  ChannelView,
  ViewRequest,
  WorkerRequest,
} from "./protocol";
import { RingBuffer } from "./ringbuffer";

const ctx = self as DedicatedWorkerGlobalScope;

let buffers = new Map<string, RingBuffer>();
let channels: ChannelMeta[] = [];
let baseNs = 0n;
let abort: AbortController | null = null;

let batches = 0;
let gaps = 0;
let lastSequence = 0n;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "start":
      void start(msg.baseUrl, msg.capacity, msg.channelIds);
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

  ctx.postMessage({ type: "stats", pointsHeld, perChannel, bytes, batches, gaps });
}

async function start(baseUrl: string, capacity: number, channelIds: string[]): Promise<void> {
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

    batches = 0;
    gaps = 0;
    lastSequence = 0n;

    ctx.postMessage({ type: "ready", channels, baseNs });

    // Held locally as well as module-wide. The catch below has to ask *this*
    // run's controller whether it was cancelled: `stop()` sets the module-level
    // `abort` to null, and a restart replaces it with a fresh controller, so by
    // the time an aborted stream throws, that variable no longer describes the
    // run that threw.
    controller = new AbortController();
    abort = controller;

    const stream = client.streamTelemetry({ channelIds }, { signal: controller.signal });

    for await (const batch of stream) {
      if (lastSequence !== 0n && batch.sequence !== lastSequence + 1n) gaps += 1;
      lastSequence = batch.sequence;
      batches += 1;

      for (const ch of batch.channels) {
        buffers.get(ch.channelId)?.push(ch.timestampsNs, ch.values);
      }
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

/**
 * Slice each channel to the requested window and downsample it.
 *
 * The output arrays are freshly allocated, so their buffers can be transferred
 * rather than copied. Transferring neuters the sender's copy — which is exactly
 * why the ring buffers themselves are never handed over.
 */
function respondToView(req: ViewRequest): void {
  const started = performance.now();

  const views: ChannelView[] = [];
  let pointsHeld = 0;
  let pointsRendered = 0;

  for (const channel of channels) {
    const buf = buffers.get(channel.id);
    if (!buf) continue;

    pointsHeld += buf.length;

    const slice = buf.sliceByTime(req.startNs, req.endNs);
    const reduced = lttb(slice.timestamps, slice.values, req.maxPoints);

    pointsRendered += reduced.values.length;
    views.push({
      channelId: channel.id,
      timestamps: reduced.timestamps,
      values: reduced.values,
    });
  }

  const transfer: ArrayBuffer[] = [];
  for (const v of views) {
    transfer.push(v.timestamps.buffer as ArrayBuffer, v.values.buffer as ArrayBuffer);
  }

  ctx.postMessage(
    {
      type: "view",
      id: req.id,
      baseNs,
      channels: views,
      pointsHeld,
      pointsRendered,
      batches,
      gaps,
      workerMs: performance.now() - started,
    },
    transfer,
  );
}
