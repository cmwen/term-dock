export type SessionState =
  "running" | "quiet" | "attention" | "exited" | "disconnected";

export interface Workspace {
  id: string;
  name: string;
  directory: string;
  shell: string;
  startupCommands: string[];
  sshTarget?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateWorkspace = Pick<
  Workspace,
  "name" | "directory" | "shell" | "startupCommands" | "sshTarget"
>;

export interface Session {
  id: string;
  workspaceId: string;
  state: SessionState;
  startedAt: string;
  lastActivityAt: string;
  exitCode?: number;
  outputPreview: string;
  cursor: number;
  outputTruncated: boolean;
  /** Optional on older persisted sessions; never inferred by a client. */
  activity?: Activity;
}

/** Mirrors `term-dock.broker/v1`, independently of the transport in use. */
export type SessionAccess = "view" | "control";

export interface CreateRemoteGrant {
  deviceLabel: string;
  access: SessionAccess;
  expiresAt?: string;
}

export interface RemoteGrantSummary {
  id: string;
  deviceLabel: string;
  access: SessionAccess;
  createdAt: string;
  expiresAt?: string;
  /** Enrollment has been exchanged; attached devices use short-lived tokens. */
  consumedAt?: string;
}

export interface IssuedRemoteGrant {
  grant: RemoteGrantSummary;
  /** Display once during explicit device enrollment; never persist in UI state. */
  secret: string;
}

export interface TerminalSize {
  rows: number;
  columns: number;
}

export interface SessionAttachment {
  protocolVersion: "term-dock.broker/v1";
  session: Session;
  access: SessionAccess;
  /**
   * Opaque, in-memory controller capability. Present only for a granted
   * control attachment; it must never be persisted, embedded in a URL, or
   * included in AI context.
   */
  attachmentId?: string;
  cursor: number;
  output: string;
  outputTruncated: boolean;
}

export type SessionEvent =
  | { type: "output"; sessionId: string; cursor: number; data: string }
  | { type: "state"; sessionId: string; cursor: number; state: SessionState };

/**
 * A bounded replay window from the local broker. `truncated` means the caller
 * must re-attach for a fresh bounded snapshot before continuing to stream.
 */
export interface SessionEventReplay {
  events: SessionEvent[];
  latestCursor: number;
  truncated: boolean;
}

export interface Activity {
  state: SessionState;
  confidence: "fact" | "inference";
  reason: string;
}

export interface AiContext {
  version: "term-dock.ai-context/v1";
  workspace: Pick<
    Workspace,
    "id" | "name" | "directory" | "shell" | "sshTarget"
  >;
  sessions: Array<
    Pick<Session, "id" | "state" | "startedAt" | "lastActivityAt" | "exitCode">
  >;
  privacy: {
    terminalOutputIncluded: false;
    secretsIncluded: false;
    generatedLocally: true;
  };
  suggestedPrompt: string;
}

export interface DeepLinkTarget {
  workspaceId: string;
  sessionId?: string;
}

export const BROKER_PROTOCOL_VERSION = "term-dock.broker/v1" as const;

export type BrokerOperation =
  | "workspaces.list"
  | "workspaces.create"
  | "workspaces.update"
  | "workspaces.archive"
  | "sessions.list"
  | "sessions.launch"
  | "sessions.attach"
  | "sessions.replay"
  | "sessions.detach"
  | "sessions.input"
  | "sessions.resize"
  | "sessions.terminate"
  | "ai.context"
  | "remote-grants.list"
  | "remote-grants.create"
  | "remote-grants.revoke";

export interface BrokerRequest<TPayload = unknown> {
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  requestId: string;
  operation: BrokerOperation;
  payload: TPayload;
}

export interface BrokerError {
  code: string;
  message: string;
  retryable: boolean;
}

export type BrokerResponse<TResult = unknown> =
  | {
      protocolVersion: typeof BROKER_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      result: TResult;
    }
  | {
      protocolVersion: typeof BROKER_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: BrokerError;
    };

/** First frame on a remote WebSocket; the token never belongs in its URL. */
export interface BrokerWebSocketAuthFrame {
  type: "auth";
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  requestId: string;
  token?: string;
}

export interface BrokerWebSocketAuthenticatedFrame {
  type: "authenticated";
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  requestId: string;
}

export interface BrokerWebSocketErrorFrame {
  type: "error";
  requestId?: string;
  error: BrokerError;
}

export interface BrokerWebSocketSubscribeFrame {
  type: "subscribe";
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  requestId: string;
  subscriptionId: string;
  sessionId: string;
  cursor: number;
}

export interface BrokerWebSocketUnsubscribeFrame {
  type: "unsubscribe";
  protocolVersion: typeof BROKER_PROTOCOL_VERSION;
  requestId: string;
  subscriptionId: string;
}

export interface BrokerWebSocketSessionEventFrame {
  type: "session-event";
  subscriptionId?: string;
  event: SessionEvent;
}

export type BrokerWebSocketClientFrame =
  | BrokerRequest
  | BrokerWebSocketAuthFrame
  | BrokerWebSocketSubscribeFrame
  | BrokerWebSocketUnsubscribeFrame;

export type BrokerWebSocketServerFrame =
  | BrokerResponse
  | BrokerWebSocketAuthenticatedFrame
  | BrokerWebSocketErrorFrame
  | BrokerWebSocketSessionEventFrame;

const sessionStates: ReadonlySet<SessionState> = new Set([
  "running",
  "quiet",
  "attention",
  "exited",
  "disconnected",
]);

export function isBrokerError(value: unknown): value is BrokerError {
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<BrokerError>;
  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SessionEvent>;
  if (event.type === "output") {
    return (
      typeof event.sessionId === "string" &&
      typeof event.cursor === "number" &&
      typeof event.data === "string"
    );
  }
  return (
    event.type === "state" &&
    typeof event.sessionId === "string" &&
    typeof event.cursor === "number" &&
    typeof event.state === "string" &&
    sessionStates.has(event.state as SessionState)
  );
}

/** Validates only server-to-client frames; relay input is validated separately. */
export function isBrokerWebSocketServerFrame(
  value: unknown,
): value is BrokerWebSocketServerFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  if (
    frame.type === "authenticated" &&
    frame.protocolVersion === BROKER_PROTOCOL_VERSION &&
    typeof frame.requestId === "string"
  )
    return true;
  if (frame.type === "error") {
    return (
      (frame.requestId === undefined || typeof frame.requestId === "string") &&
      isBrokerError(frame.error)
    );
  }
  if (frame.type === "session-event") {
    return (
      (frame.subscriptionId === undefined ||
        typeof frame.subscriptionId === "string") &&
      isSessionEvent(frame.event)
    );
  }
  if (
    frame.protocolVersion !== BROKER_PROTOCOL_VERSION ||
    typeof frame.requestId !== "string" ||
    typeof frame.ok !== "boolean"
  )
    return false;
  return frame.ok ? "result" in frame : isBrokerError(frame.error);
}
