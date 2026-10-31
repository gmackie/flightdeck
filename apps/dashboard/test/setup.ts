import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { FakeWebSocket } from "./helpers";

// Pages open live sockets; no test should reach the network. Tests drive FakeWebSocket instead.
beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(cleanup);
