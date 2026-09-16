import { configureStore } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";

import viewReducer from "./viewSlice";

/**
 * The application store.
 *
 * It holds the view window and nothing else. Telemetry lives in the worker's
 * ring buffers and reaches the main thread only as a few thousand already
 * downsampled points, which go straight to ECharts without passing through
 * here. `viewSlice.test.ts` asserts that shape so it stays true.
 */
export const store = configureStore({
  reducer: { view: viewReducer },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
