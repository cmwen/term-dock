import type {
  BrokerOperation,
  BrokerRequest,
  BrokerResponse,
  BrokerWebSocketAuthFrame,
  BrokerWebSocketErrorFrame,
  BrokerWebSocketServerFrame,
  BrokerWebSocketSubscribeFrame,
  BrokerWebSocketUnsubscribeFrame,
  SessionEvent,
} from "@term-dock/broker-contract";
import {
  BROKER_PROTOCOL_VERSION,
  isBrokerError,
  isBrokerWebSocketServerFrame,
} from "@term-dock/broker-contract";
import { BrokerTransportError } from "./errors";
import type { BrokerTransport } from "./index";

const OPEN_STATE = 1;

export interface BrokerSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type BrokerSocketConstructor = new (url: string) => BrokerSocket;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  id: string;
  sessionId: string;
  cursor: number;
  onEvent: (event: SessionEvent) => void;
}

export interface WebSocketBrokerTransportOptions {
  url: string;
  /** Return a short-lived token; this package sends it only in the auth frame. */
  accessToken?: () => string | Promise<string>;
  webSocketImpl?: BrokerSocketConstructor;
  requestId?: () => string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface WebSocketBrokerTransport extends BrokerTransport {
  close(): void;
}

function parseFrame(data: unknown): BrokerWebSocketServerFrame {
  if (typeof data !== "string") {
    throw new BrokerTransportError(
      "invalid_response",
      "Broker WebSocket returned a non-text frame.",
    );
  }
  try {
    const frame = JSON.parse(data) as unknown;
    if (!isBrokerWebSocketServerFrame(frame)) throw new Error("invalid frame");
    return frame;
  } catch {
    throw new BrokerTransportError(
      "invalid_response",
      "Broker WebSocket returned invalid JSON.",
    );
  }
}

function responseError(response: BrokerResponse | BrokerWebSocketErrorFrame) {
  if ("error" in response) {
    if (isBrokerError(response.error)) {
      const error = response.error;
      return new BrokerTransportError(
        error.code,
        error.message,
        error.retryable,
      );
    }
  }
  return new BrokerTransportError(
    "invalid_response",
    "Broker WebSocket returned an invalid error envelope.",
  );
}

export function createWebSocketBrokerTransport({
  url,
  accessToken,
  webSocketImpl,
  requestId = () => crypto.randomUUID(),
  connectTimeoutMs = 10_000,
  requestTimeoutMs = 15_000,
}: WebSocketBrokerTransportOptions): WebSocketBrokerTransport {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new BrokerTransportError(
      "invalid_endpoint",
      "Broker WebSocket endpoint must be a valid URL.",
    );
  }
  if (!/^wss?:$/.test(endpoint.protocol)) {
    throw new BrokerTransportError(
      "invalid_endpoint",
      "Broker WebSocket endpoint must use WSS or WS for local development.",
    );
  }

  const Socket =
    webSocketImpl ??
    (
      globalThis as typeof globalThis & {
        WebSocket?: BrokerSocketConstructor;
      }
    ).WebSocket;
  if (!Socket)
    throw new BrokerTransportError(
      "missing_websocket",
      "This runtime does not provide WebSocket.",
    );

  const pending = new Map<string, PendingRequest>();
  const subscriptions = new Map<string, Subscription>();
  let socket: BrokerSocket | undefined;
  let connectingSocket: BrokerSocket | undefined;
  let connecting: Promise<void> | undefined;
  let intentionallyClosed = false;

  const connectionError = (message: string) =>
    new BrokerTransportError("network_error", message, true);

  const rejectPending = (error: BrokerTransportError) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
  };

  const send = (frame: unknown) => {
    if (!socket || socket.readyState !== OPEN_STATE)
      throw connectionError("Broker WebSocket is not connected.");
    socket.send(JSON.stringify(frame));
  };

  const resubscribe = () => {
    for (const subscription of subscriptions.values()) {
      send({
        type: "subscribe",
        protocolVersion: BROKER_PROTOCOL_VERSION,
        requestId: requestId(),
        subscriptionId: subscription.id,
        sessionId: subscription.sessionId,
        cursor: subscription.cursor,
      } satisfies BrokerWebSocketSubscribeFrame);
    }
  };

  const dispatchEvent = (
    frame: Extract<BrokerWebSocketServerFrame, { type: "session-event" }>,
  ) => {
    const targets = frame.subscriptionId
      ? [subscriptions.get(frame.subscriptionId)]
      : [...subscriptions.values()].filter(
          (subscription) => subscription.sessionId === frame.event.sessionId,
        );
    for (const subscription of targets) {
      if (!subscription || frame.event.cursor <= subscription.cursor) continue;
      subscription.cursor = frame.event.cursor;
      subscription.onEvent(frame.event);
    }
  };

  const connect = async () => {
    if (intentionallyClosed)
      throw new BrokerTransportError(
        "transport_closed",
        "Broker WebSocket transport is closed.",
      );
    const token = accessToken ? await accessToken() : undefined;
    const authId = requestId();
    const candidate = new Socket(endpoint.toString());
    connectingSocket = candidate;
    let opened = false;
    let authenticated = false;
    let resolveOpen!: () => void;
    let rejectOpen!: (error: unknown) => void;
    let resolveAuth!: () => void;
    let rejectAuth!: (error: unknown) => void;
    const openPromise = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const authPromise = new Promise<void>((resolve, reject) => {
      resolveAuth = resolve;
      rejectAuth = reject;
    });

    candidate.onopen = () => {
      opened = true;
      resolveOpen();
    };
    candidate.onerror = () => {
      const error = connectionError("Broker WebSocket connection failed.");
      if (!opened) rejectOpen(error);
      if (authenticated) rejectPending(error);
      else rejectAuth(error);
    };
    candidate.onclose = (event) => {
      const error = connectionError(
        event.reason || "Broker WebSocket connection closed.",
      );
      if (!authenticated) rejectAuth(error);
      if (socket === candidate) {
        socket = undefined;
        rejectPending(error);
      }
    };
    candidate.onmessage = ({ data }) => {
      let frame: BrokerWebSocketServerFrame;
      try {
        frame = parseFrame(data);
      } catch (error) {
        if (!authenticated) rejectAuth(error);
        return;
      }
      if (
        "type" in frame &&
        frame.type === "authenticated" &&
        frame.requestId === authId
      ) {
        if (frame.protocolVersion !== BROKER_PROTOCOL_VERSION) {
          rejectAuth(
            new BrokerTransportError(
              "protocol_mismatch",
              "Broker WebSocket authentication used an unsupported protocol.",
            ),
          );
        } else {
          resolveAuth();
        }
        return;
      }
      if (
        "type" in frame &&
        frame.type === "error" &&
        frame.requestId === authId
      ) {
        rejectAuth(responseError(frame));
        return;
      }
      if ("type" in frame && frame.type === "session-event") {
        dispatchEvent(frame);
        return;
      }
      const responseId =
        "requestId" in frame && typeof frame.requestId === "string"
          ? frame.requestId
          : undefined;
      if (!responseId) return;
      const request = pending.get(responseId);
      if (!request) return;
      pending.delete(responseId);
      clearTimeout(request.timer);
      if ("ok" in frame && frame.ok === false) {
        request.reject(responseError(frame as BrokerResponse));
        return;
      }
      if (!(
        "protocolVersion" in frame &&
        frame.protocolVersion === BROKER_PROTOCOL_VERSION &&
        "ok" in frame &&
        frame.ok === true &&
        "result" in frame
      )) {
        request.reject(
          new BrokerTransportError(
            "protocol_mismatch",
            "Broker WebSocket response did not match the request protocol.",
          ),
        );
        return;
      }
      request.resolve(frame.result);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(connectionError("Broker WebSocket connection timed out.")),
          connectTimeoutMs,
        );
        openPromise.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      candidate.send(
        JSON.stringify({
          type: "auth",
          protocolVersion: BROKER_PROTOCOL_VERSION,
          requestId: authId,
          ...(token ? { token } : {}),
        } satisfies BrokerWebSocketAuthFrame),
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              connectionError("Broker WebSocket authentication timed out."),
            ),
          connectTimeoutMs,
        );
        authPromise.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      authenticated = true;
      if (intentionallyClosed)
        throw new BrokerTransportError(
          "transport_closed",
          "Broker WebSocket transport is closed.",
        );
      socket = candidate;
      resubscribe();
      if (connectingSocket === candidate) connectingSocket = undefined;
    } catch (error) {
      if (socket === candidate) socket = undefined;
      if (connectingSocket === candidate) connectingSocket = undefined;
      candidate.close(1000, "connect failed");
      throw error;
    }
  };

  const ensureConnected = async () => {
    if (socket?.readyState === OPEN_STATE) return;
    if (connecting) return connecting;
    connecting = connect().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  const transport: WebSocketBrokerTransport = {
    async request<TResult, TPayload>(
      operation: BrokerOperation,
      payload: TPayload,
    ) {
      await ensureConnected();
      const id = requestId();
      const frame: BrokerRequest<TPayload> = {
        protocolVersion: BROKER_PROTOCOL_VERSION,
        requestId: id,
        operation,
        payload,
      };
      return new Promise<TResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new BrokerTransportError(
              "request_timeout",
              "Broker WebSocket request timed out.",
              true,
            ),
          );
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as TResult),
          reject,
          timer,
        });
        try {
          send(frame);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    async subscribe(sessionId, cursor, onEvent) {
      await ensureConnected();
      const subscription: Subscription = {
        id: requestId(),
        sessionId,
        cursor,
        onEvent,
      };
      subscriptions.set(subscription.id, subscription);
      try {
        send({
          type: "subscribe",
          protocolVersion: BROKER_PROTOCOL_VERSION,
          requestId: requestId(),
          subscriptionId: subscription.id,
          sessionId,
          cursor,
        } satisfies BrokerWebSocketSubscribeFrame);
      } catch (error) {
        subscriptions.delete(subscription.id);
        throw error;
      }
      return () => {
        if (!subscriptions.delete(subscription.id)) return;
        if (socket?.readyState !== OPEN_STATE) return;
        send({
          type: "unsubscribe",
          protocolVersion: BROKER_PROTOCOL_VERSION,
          requestId: requestId(),
          subscriptionId: subscription.id,
        } satisfies BrokerWebSocketUnsubscribeFrame);
      };
    },
    close() {
      intentionallyClosed = true;
      subscriptions.clear();
      rejectPending(
        new BrokerTransportError(
          "transport_closed",
          "Broker WebSocket transport is closed.",
        ),
      );
      connectingSocket?.close(1000, "client closed");
      connectingSocket = undefined;
      socket?.close(1000, "client closed");
      socket = undefined;
    },
  };

  return transport;
}
