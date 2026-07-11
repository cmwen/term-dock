import { describe, expect, it, vi } from "vitest";
import { BROKER_PROTOCOL_VERSION } from "@term-dock/broker-contract";
import type { BrokerOperation } from "@term-dock/broker-contract";
import {
  type BrokerTransportError,
  createBrokerClient,
  createHttpBrokerTransport,
  createWebSocketBrokerTransport,
} from "./index";
import type { BrokerSocket } from "./index";

class FakeSocket implements BrokerSocket {
  static latest: FakeSocket | undefined;
  readonly frames: unknown[] = [];
  readonly url: string;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.latest = this;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string) {
    this.frames.push(JSON.parse(data));
  }

  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(_code?: number, _reason?: string) {
    this.readyState = 3;
  }

  drop(reason = "dropped") {
    this.readyState = 3;
    this.onclose?.({ reason });
  }
}

describe("HTTP broker transport", () => {
  it("rejects malformed endpoints before making a request", () => {
    expect(() => createHttpBrokerTransport({ baseUrl: "not a URL" })).toThrow(
      expect.objectContaining({ code: "invalid_endpoint" }),
    );
  });

  it("sends versioned requests with caller-supplied short-lived auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = JSON.parse(String(init?.body));
      expect(input.toString()).toBe("https://relay.test/v1/rpc");
      expect(request).toMatchObject({
        protocolVersion: BROKER_PROTOCOL_VERSION,
        requestId: "req-1",
        operation: "workspaces.list",
        payload: {},
      });
      expect(
        (init?.headers as Record<string, string> | undefined)?.authorization,
      ).toBe("Bearer ephemeral");
      return new Response(
        JSON.stringify({
          protocolVersion: BROKER_PROTOCOL_VERSION,
          requestId: "req-1",
          ok: true,
          result: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createBrokerClient(
      createHttpBrokerTransport({
        baseUrl: "https://relay.test/",
        accessToken: () => "ephemeral",
        fetchImpl,
        requestId: () => "req-1",
      }),
    );
    expect(await client.listWorkspaces()).toEqual([]);
  });

  it("keeps workspace and launch mutations on the broker contract", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = createBrokerClient({
      request: async <TResult>(
        operation: BrokerOperation,
        payload: unknown,
      ) => {
        calls.push([operation, payload]);
        return undefined as TResult;
      },
    });
    const workspace = {
      name: "Term Dock",
      directory: "/tmp/term-dock",
      shell: "/bin/zsh",
      startupCommands: [],
    };
    await client.createWorkspace(workspace);
    await client.updateWorkspace("ws-1", workspace);
    await client.archiveWorkspace("ws-1");
    await client.launchWorkspace("ws-1");
    expect(calls).toEqual([
      ["workspaces.create", { workspace }],
      ["workspaces.update", { id: "ws-1", workspace }],
      ["workspaces.archive", { id: "ws-1" }],
      ["sessions.launch", { workspaceId: "ws-1" }],
    ]);
  });

  it("requires an opaque controller attachment for PTY mutations", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = createBrokerClient({
      request: async <TResult>(
        operation: BrokerOperation,
        payload: unknown,
      ) => {
        calls.push([operation, payload]);
        return undefined as TResult;
      },
    });

    await client.detachSession("sess-1", "attach-1");
    await client.writeSessionInput("sess-1", "attach-1", "pwd\n");
    await client.resizeSession("sess-1", "attach-1", {
      rows: 32,
      columns: 113,
    });
    await client.terminateSession("sess-1", "attach-1", true);

    expect(calls).toEqual([
      ["sessions.detach", { sessionId: "sess-1", attachmentId: "attach-1" }],
      [
        "sessions.input",
        { sessionId: "sess-1", attachmentId: "attach-1", data: "pwd\n" },
      ],
      [
        "sessions.resize",
        {
          sessionId: "sess-1",
          attachmentId: "attach-1",
          size: { rows: 32, columns: 113 },
        },
      ],
      [
        "sessions.terminate",
        { sessionId: "sess-1", attachmentId: "attach-1", confirmed: true },
      ],
    ]);
  });

  it("keeps cursor replay on the versioned broker contract", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = createBrokerClient({
      request: async <TResult>(
        operation: BrokerOperation,
        payload: unknown,
      ) => {
        calls.push([operation, payload]);
        return {
          events: [],
          latestCursor: 12,
          truncated: false,
        } as TResult;
      },
    });

    await expect(client.replaySessionEvents("sess-1", 8)).resolves.toEqual({
      events: [],
      latestCursor: 12,
      truncated: false,
    });
    expect(calls).toEqual([
      ["sessions.replay", { sessionId: "sess-1", cursor: 8 }],
    ]);
  });

  it("rejects mismatched response envelopes", async () => {
    const transport = createHttpBrokerTransport({
      baseUrl: "https://relay.test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            protocolVersion: "other",
            requestId: "wrong",
            ok: true,
            result: [],
          }),
          { status: 200 },
        ),
      requestId: () => "req-2",
    });
    await expect(transport.request("sessions.list", {})).rejects.toMatchObject({
      code: "protocol_mismatch",
    } satisfies Partial<BrokerTransportError>);
  });

  it("reports when a request-only transport cannot stream session events", async () => {
    const client = createBrokerClient({
      request: async <TResult>() => [] as TResult,
    });
    await expect(
      client.subscribeSession("sess-1", 0, () => undefined),
    ).rejects.toMatchObject({ code: "stream_unsupported" });
  });

  it("delegates cursor-aware session streams to streaming transports", async () => {
    const onEvent = vi.fn();
    const unsubscribe = vi.fn();
    const client = createBrokerClient({
      request: async <TResult>() => undefined as TResult,
      subscribe: async (sessionId, cursor, handler) => {
        expect(sessionId).toBe("sess-1");
        expect(cursor).toBe(12);
        handler({
          type: "output",
          sessionId,
          cursor: 13,
          data: "ready\n",
        });
        return unsubscribe;
      },
    });

    const cleanup = await client.subscribeSession("sess-1", 12, onEvent);
    expect(onEvent).toHaveBeenCalledWith({
      type: "output",
      sessionId: "sess-1",
      cursor: 13,
      data: "ready\n",
    });
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("maps network failures to retryable transport errors", async () => {
    const transport = createHttpBrokerTransport({
      baseUrl: "https://relay.test",
      fetchImpl: async () => {
        throw new Error("offline");
      },
      requestId: () => "req-3",
    });
    await expect(transport.request("sessions.list", {})).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    });
  });
});

describe("WebSocket broker transport", () => {
  it("authenticates without putting the token in the endpoint URL", async () => {
    let sequence = 0;
    const transport = createWebSocketBrokerTransport({
      url: "wss://relay.test/socket",
      accessToken: () => "short-lived",
      webSocketImpl: FakeSocket,
      requestId: () => `id-${++sequence}`,
    });
    const pending = transport.request("workspaces.list", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = FakeSocket.latest;
    expect(socket?.url).toBe("wss://relay.test/socket");
    socket?.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket?.frames[0]).toMatchObject({
      type: "auth",
      requestId: "id-1",
      token: "short-lived",
    });
    socket?.receive({
      type: "authenticated",
      protocolVersion: BROKER_PROTOCOL_VERSION,
      requestId: "id-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket?.frames[1]).toMatchObject({
      protocolVersion: BROKER_PROTOCOL_VERSION,
      requestId: "id-2",
      operation: "workspaces.list",
    });
    socket?.receive({
      protocolVersion: BROKER_PROTOCOL_VERSION,
      requestId: "id-2",
      ok: true,
      result: [],
    });
    await expect(pending).resolves.toEqual([]);
    transport.close();
  });

  it("rejects non-WebSocket endpoints", () => {
    expect(() =>
      createWebSocketBrokerTransport({
        url: "https://relay.test/socket",
        webSocketImpl: FakeSocket,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_endpoint" }));
  });

  it("resumes session events from a cursor and sends unsubscribe", async () => {
    const transport = createWebSocketBrokerTransport({
      url: "ws://localhost:8787/socket",
      webSocketImpl: FakeSocket,
      requestId: (() => {
        let sequence = 0;
        return () => `stream-${++sequence}`;
      })(),
    });
    const onEvent = vi.fn();
    const client = createBrokerClient(transport);
    const subscribed = client.subscribeSession("sess-1", 7, onEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = FakeSocket.latest;
    socket?.open();
    await Promise.resolve();
    socket?.receive({
      type: "authenticated",
      protocolVersion: BROKER_PROTOCOL_VERSION,
      requestId: "stream-1",
    });
    const cleanup = await subscribed;
    const subscribeFrame = socket?.frames.find(
      (frame) => (frame as { type?: string }).type === "subscribe",
    ) as { subscriptionId: string };
    socket?.receive({
      type: "session-event",
      subscriptionId: subscribeFrame.subscriptionId,
      event: {
        type: "output",
        sessionId: "sess-1",
        cursor: 8,
        data: "ready\n",
      },
    });
    expect(onEvent).toHaveBeenCalledOnce();
    socket?.drop();
    const reconnecting = client.listSessions();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconnected = FakeSocket.latest;
    reconnected?.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const authFrame = reconnected?.frames[0] as { requestId: string };
    reconnected?.receive({
      type: "authenticated",
      protocolVersion: BROKER_PROTOCOL_VERSION,
      requestId: authFrame.requestId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconnected?.frames).toContainEqual(
      expect.objectContaining({
        type: "subscribe",
        subscriptionId: subscribeFrame.subscriptionId,
        cursor: 8,
      }),
    );
    const requestFrame = reconnected?.frames.find(
      (frame) =>
        (frame as { operation?: string }).operation === "sessions.list",
    ) as { requestId: string };
    reconnected?.receive({
      protocolVersion: BROKER_PROTOCOL_VERSION,
      requestId: requestFrame.requestId,
      ok: true,
      result: [],
    });
    await expect(reconnecting).resolves.toEqual([]);
    cleanup();
    expect(reconnected?.frames.at(-1)).toMatchObject({
      type: "unsubscribe",
      subscriptionId: subscribeFrame.subscriptionId,
    });
    transport.close();
  });
});
