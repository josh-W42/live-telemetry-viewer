import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";

import anomaliesReducer from "./anomaliesSlice";
import channelsReducer from "./channelsSlice";
import viewReducer from "./viewSlice";

/**
 * The application store.
 *
 * It holds the view window, which channels are drawn, and the anomalies
 * detected — UI state and small metadata, never telemetry. The 2.4M retained
 * samples live in the worker's ring buffers and reach the main thread only as a
 * few thousand
 * already-downsampled points, which go straight to ECharts without passing
 * through here. Every slice carries a test asserting that shape, so it stays
 * true as they grow.
 */
export const store = configureStore({
  reducer: {
    view: viewReducer,
    channels: channelsReducer,
    anomalies: anomaliesReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
