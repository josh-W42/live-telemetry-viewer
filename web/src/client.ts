import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { TelemetryService } from "./gen/telemetry/v1/telemetry_pb";

// The browser talks to the Go server directly — no Vite proxy. That is the point
// of Connect over HTTP: unlike grpc-web, it needs no translating sidecar.
const baseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

const transport = createConnectTransport({ baseUrl });

export const telemetryClient = createClient(TelemetryService, transport);
