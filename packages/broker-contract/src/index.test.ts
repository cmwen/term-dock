import { describe, expect, it } from "vitest";
import { BROKER_PROTOCOL_VERSION, isBrokerWebSocketServerFrame } from "./index";

describe("WebSocket broker contract", () => {
  it("accepts versioned authentication, response, and event frames", () => {
    expect(
      isBrokerWebSocketServerFrame({
        type: "authenticated",
        protocolVersion: BROKER_PROTOCOL_VERSION,
        requestId: "auth-1",
      }),
    ).toBe(true);
    expect(
      isBrokerWebSocketServerFrame({
        protocolVersion: BROKER_PROTOCOL_VERSION,
        requestId: "request-1",
        ok: true,
        result: [],
      }),
    ).toBe(true);
    expect(
      isBrokerWebSocketServerFrame({
        type: "session-event",
        subscriptionId: "sub-1",
        event: {
          type: "state",
          sessionId: "sess-1",
          cursor: 4,
          state: "quiet",
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed events and unsupported protocol versions", () => {
    expect(
      isBrokerWebSocketServerFrame({
        protocolVersion: "other",
        requestId: "request-1",
        ok: true,
        result: [],
      }),
    ).toBe(false);
    expect(
      isBrokerWebSocketServerFrame({
        type: "session-event",
        event: {
          type: "state",
          sessionId: "sess-1",
          cursor: 4,
          state: "unknown",
        },
      }),
    ).toBe(false);
  });
});
