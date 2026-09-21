import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { TelemetryService } from "./gen/telemetry/v1/telemetry_pb";

// The browser talks to the Go server directly — no Vite proxy. That is the point
// of Connect over HTTP: unlike grpc-web, it needs no translating sidecar.
/**
 * Same origin by default: the Go binary serves this page and the API together,
 * so there is nothing to configure and no CORS. VITE_API_URL stays as an
 * override for pointing a dev build at a server elsewhere - which is what
 * web/.env.development does, since Vite serves the page from :5173 while the
 * API answers on :8080.
 */
const baseUrl =
  import.meta.env.VITE_API_URL ??
  (typeof window === "undefined" ? "http://localhost:8080" : window.location.origin);


const transport = createConnectTransport({ baseUrl });

export const telemetryClient = createClient(TelemetryService, transport);
