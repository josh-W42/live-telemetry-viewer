import { describe, expect, it } from "vitest";

import {
  AXIS_WIDTH,
  colorFor,
  plotFraction,
  RenderTimer,
  viewerGridInsets,
  viewerOption,
  yAxes,
} from "./types";
import type { Channel } from "../gen/telemetry/v1/telemetry_pb";

function channel(id: string, unit: string, min: number, max: number): Channel {
  return {
    id,
    name: id,
    unit,
    sampleRateHz: 1000,
    displayMin: min,
    displayMax: max,
  } as Channel;
}

const CHANNELS = [
  channel("chamber_pressure", "psi", 0, 1500),
  channel("chamber_temp", "K", 0, 4000),
  channel("vibration", "g", 0, 15),
  channel("fuel_flow", "kg/s", 0, 20),
];

/** Burn enough wall clock that the timer records something above zero. */
function slowly(ms = 1): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

describe("RenderTimer", () => {
  it("starts empty", () => {
    const timer = new RenderTimer();
    expect(timer.take()).toEqual({ totalMs: 0, maxMs: 0, count: 0 });
    expect(timer.renderCount()).toBe(0);
  });

  it("returns whatever the measured function returns", () => {
    const timer = new RenderTimer();
    expect(timer.measure(() => 42)).toBe(42);
  });

  it("counts renders as well as timing them", () => {
    const timer = new RenderTimer();
    for (let i = 0; i < 3; i++) timer.measure(() => slowly());

    const stats = timer.take();
    expect(stats.count).toBe(3);
    expect(stats.totalMs).toBeGreaterThan(0);
    expect(stats.maxMs).toBeGreaterThan(0);
    expect(stats.totalMs).toBeGreaterThanOrEqual(stats.maxMs);
  });

  it("resets the count along with the timings", () => {
    const timer = new RenderTimer();
    timer.measure(() => slowly());
    timer.take();

    expect(timer.take()).toEqual({ totalMs: 0, maxMs: 0, count: 0 });
  });

  // Still counts a render that threw, because the thread spent the time either
  // way and a metric that under-reports on failure is worse than none.
  it("counts and times a render that throws", () => {
    const timer = new RenderTimer();
    expect(() =>
      timer.measure(() => {
        slowly();
        throw new Error("setOption blew up");
      }),
    ).toThrow("setOption blew up");

    const stats = timer.take();
    expect(stats.count).toBe(1);
    expect(stats.totalMs).toBeGreaterThan(0);
  });

  /*
  The reason there are two counters rather than one.

  `take()` is destructive, and the status bar and the benchmark harness both
  want to know the render rate. If they shared the resetting accumulator,
  whichever polled first would silently consume the other's data and the run
  would report a fraction of the work it actually did — the same class of
  self-inflicted measurement error as reading results mid-run.
  */
  describe("the lifetime count", () => {
    it("is not disturbed by taking the resettable stats", () => {
      const timer = new RenderTimer();
      for (let i = 0; i < 5; i++) timer.measure(() => undefined);

      timer.take();
      timer.take();

      expect(timer.renderCount()).toBe(5);
    });

    it("keeps accumulating across takes", () => {
      const timer = new RenderTimer();

      timer.measure(() => undefined);
      expect(timer.take().count).toBe(1);

      timer.measure(() => undefined);
      timer.measure(() => undefined);
      expect(timer.take().count).toBe(2);

      expect(timer.renderCount()).toBe(3);
    });

    it("never goes backwards, so a rate differenced from it cannot go negative", () => {
      const timer = new RenderTimer();
      let previous = timer.renderCount();

      for (let i = 0; i < 10; i++) {
        timer.measure(() => undefined);
        if (i % 3 === 0) timer.take();

        const now = timer.renderCount();
        expect(now).toBeGreaterThanOrEqual(previous);
        previous = now;
      }
    });
  });
});

describe("yAxes", () => {
  it("gives every channel its own axis, in declaration order", () => {
    const axes = yAxes(CHANNELS, null);
    expect(axes).toHaveLength(CHANNELS.length);
    expect(axes.map((a) => a.name)).toEqual(["psi", "K", "g", "kg/s"]);
  });

  /*
  The old right-hand axis was labelled "g / kg·s⁻¹" because vibration and fuel
  flow shared it, so a tick reading 12 meant 12 of something unstated. Each axis
  now carries its own channel's unit verbatim — including "kg/s", which is one
  unit that happens to contain a slash.
  */
  it("labels each axis with its own channel's unit", () => {
    const axes = yAxes(CHANNELS, null);
    for (const [i, c] of CHANNELS.entries()) {
      expect(axes[i]!.name).toBe(c.unit);
    }
  });

  it("takes each range from the channel metadata, never from the data", () => {
    expect(yAxes(CHANNELS, null).map((a) => [a.min, a.max])).toEqual([
      [0, 1500],
      [0, 4000],
      [0, 15],
      [0, 20],
    ]);
  });

  it("splits the axes between the two sides and offsets each one outward", () => {
    const axes = yAxes(CHANNELS, null);
    expect(axes.map((a) => a.position)).toEqual(["left", "left", "right", "right"]);
    expect(axes.map((a) => a.offset)).toEqual([0, AXIS_WIDTH, 0, AXIS_WIDTH]);
  });

  /*
  The requirement, stated as an assertion.

  Unticking fuel flow used to change the numbers on vibration's axis, because
  both shared one `scale: true` axis. Nothing about an axis may now depend on
  what is visible except its colour: not its range, not its position, not its
  offset, and above all not whether it exists at all — an axis that vanished
  would let the others slide over and change every trace's apparent width
  instead, trading vertical instability for horizontal.
  */
  it("produces geometrically identical axes whatever is visible", () => {
    const ids = CHANNELS.map((c) => c.id);
    const subsets: (string[] | null)[] = [
      null,
      ids,
      [],
      ["vibration"],
      ["chamber_pressure", "fuel_flow"],
      ids.filter((id) => id !== "fuel_flow"),
    ];

    const geometryOf = (visible: string[] | null) =>
      yAxes(CHANNELS, visible).map(({ type, position, offset, min, max, name }) => ({
        type,
        position,
        offset,
        min,
        max,
        name,
      }));

    const reference = geometryOf(null);
    for (const subset of subsets) {
      expect(geometryOf(subset)).toEqual(reference);
    }
  });

  it("dims a hidden channel's axis and leaves a visible one at full colour", () => {
    const axes = yAxes(CHANNELS, ["chamber_pressure"]);

    expect(axes[0]!.axisLabel.color).toBe(colorFor("chamber_pressure"));
    expect(axes[2]!.axisLabel.color).not.toBe(colorFor("vibration"));
  });

  // Four sets of gridlines would be a moiré pattern.
  it("draws gridlines for one axis only", () => {
    expect(yAxes(CHANNELS, null).filter((a) => a.splitLine.show)).toHaveLength(1);
  });

  it("handles a single channel without putting anything on the right", () => {
    const axes = yAxes([CHANNELS[0]!], null);
    expect(axes).toHaveLength(1);
    expect(axes[0]!.position).toBe("left");
  });

  it("handles no channels at all", () => {
    expect(yAxes([], null)).toEqual([]);
  });
});

describe("viewerGridInsets", () => {
  it("reserves a slot for every axis on each side", () => {
    expect(viewerGridInsets(4)).toEqual({ left: 2 * AXIS_WIDTH, right: 2 * AXIS_WIDTH });
  });

  it("keeps a minimum inset when there is nothing to put on a side", () => {
    expect(viewerGridInsets(1)).toEqual({ left: AXIS_WIDTH, right: AXIS_WIDTH });
    expect(viewerGridInsets(0)).toEqual({ left: AXIS_WIDTH, right: AXIS_WIDTH });
  });

  /*
  It takes a count, not a visible set, and that is what makes plot geometry
  impossible to perturb by toggling a channel. The signature is the proof; this
  pins it so a later change cannot quietly add the parameter.
  */
  it("depends only on how many channels exist", () => {
    expect(viewerGridInsets.length).toBe(1);
  });
});

describe("viewerOption", () => {
  it("points each series at its own axis", () => {
    expect(viewerOption(CHANNELS).series.map((s) => s.yAxisIndex)).toEqual([0, 1, 2, 3]);
  });

  it("sizes the grid to fit the axes", () => {
    const option = viewerOption(CHANNELS);
    const insets = viewerGridInsets(CHANNELS.length);

    expect(option.grid.left).toBe(insets.left);
    expect(option.grid.right).toBe(insets.right);
  });

  /*
  The channel checkboxes are the one authority on visibility. An ECharts legend
  is a second one: clicking it hides a series without the store knowing, and the
  chart and the channel list then disagree about what is on screen.
  */
  it("has no legend", () => {
    expect(viewerOption(CHANNELS)).not.toHaveProperty("legend");
  });

  // Same reason baseOption omits it: letting the library downsample would hide
  // the cost M3 exists to remove.
  it("does not enable ECharts' own sampling", () => {
    for (const series of viewerOption(CHANNELS).series) {
      expect(series).not.toHaveProperty("sampling");
    }
  });
});

describe("plotFraction", () => {
  const rect = { left: 0, width: 1000 } as DOMRect;

  it("maps the plot's left and right edges to 0 and 1", () => {
    expect(plotFraction(100, rect, { left: 100, right: 100 })).toBeCloseTo(0);
    expect(plotFraction(900, rect, { left: 100, right: 100 })).toBeCloseTo(1);
  });

  it("clamps outside the plot area, so dragging off the chart cannot overshoot", () => {
    expect(plotFraction(0, rect, { left: 100, right: 100 })).toBe(0);
    expect(plotFraction(2000, rect, { left: 100, right: 100 })).toBe(1);
  });

  /*
  The wider insets the per-channel axes need would otherwise be mapped with
  baseOption's narrower ones, putting every zoom anchor slightly off — a silent
  drift in the code the zoom-out bug lived in.
  */
  it("uses the insets it is given, not a module constant", () => {
    expect(plotFraction(300, rect, { left: 100, right: 100 })).toBeCloseTo(0.25);
    expect(plotFraction(300, rect, { left: 200, right: 0 })).toBeCloseTo(0.125);
  });

  it("does not divide by zero when the plot has no width", () => {
    expect(plotFraction(50, rect, { left: 600, right: 600 })).toBe(0.5);
  });
});
