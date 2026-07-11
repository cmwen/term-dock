import type {
  AiContext,
  BrokerOperation,
  BrokerRequest,
  BrokerResponse,
  CreateWorkspace,
  CreateRemoteGrant,
  IssuedRemoteGrant,
  RemoteGrantSummary,
  Session,
  SessionAccess,
  SessionAttachment,
  SessionEvent,
  SessionEventReplay,
  TerminalSize,
  Workspace,
} from "@term-dock/broker-contract";
import { BROKER_PROTOCOL_VERSION } from "@term-dock/broker-contract";
import { BrokerTransportError } from "./errors";

export interface BrokerTransport {
  request<TResult, TPayload = unknown>(
    operation: BrokerOperation,
    payload: TPayload,
  ): Promise<TResult>;
  subscribe?(
    sessionId: string,
    cursor: number,
    onEvent: (event: SessionEvent) => void,
  ): Promise<() => void>;
}

export interface BrokerClient {
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(workspace: CreateWorkspace): Promise<Workspace>;
  updateWorkspace(id: string, workspace: CreateWorkspace): Promise<Workspace>;
  archiveWorkspace(id: string): Promise<void>;
  listSessions(): Promise<Session[]>;
  launchWorkspace(workspaceId: string): Promise<Session>;
  attachSession(
    sessionId: string,
    access: SessionAccess,
  ): Promise<SessionAttachment>;
  replaySessionEvents(
    sessionId: string,
    cursor: number,
  ): Promise<SessionEventReplay>;
  detachSession(sessionId: string, attachmentId: string): Promise<void>;
  subscribeSession(
    sessionId: string,
    cursor: number,
    onEvent: (event: SessionEvent) => void,
  ): Promise<() => void>;
  writeSessionInput(
    sessionId: string,
    attachmentId: string,
    data: string,
  ): Promise<void>;
  resizeSession(
    sessionId: string,
    attachmentId: string,
    size: TerminalSize,
  ): Promise<void>;
  terminateSession(
    sessionId: string,
    attachmentId: string,
    confirmed: boolean,
  ): Promise<void>;
  getAiContext(workspaceId: string): Promise<AiContext>;
  listRemoteGrants(): Promise<RemoteGrantSummary[]>;
  createRemoteGrant(grant: CreateRemoteGrant): Promise<IssuedRemoteGrant>;
  revokeRemoteGrant(id: string): Promise<void>;
}

export function createBrokerClient(transport: BrokerTransport): BrokerClient {
  return {
    listWorkspaces: () => transport.request("workspaces.list", {}),
    createWorkspace: (workspace) =>
      transport.request("workspaces.create", { workspace }),
    updateWorkspace: (id, workspace) =>
      transport.request("workspaces.update", { id, workspace }),
    archiveWorkspace: (id) => transport.request("workspaces.archive", { id }),
    listSessions: () => transport.request("sessions.list", {}),
    launchWorkspace: (workspaceId) =>
      transport.request("sessions.launch", { workspaceId }),
    attachSession: (sessionId, access) =>
      transport.request("sessions.attach", { sessionId, access }),
    replaySessionEvents: (sessionId, cursor) =>
      transport.request("sessions.replay", { sessionId, cursor }),
    detachSession: (sessionId, attachmentId) =>
      transport.request("sessions.detach", { sessionId, attachmentId }),
    subscribeSession: (sessionId, cursor, onEvent) => {
      if (!transport.subscribe) {
        return Promise.reject(
          new BrokerTransportError(
            "stream_unsupported",
            "This broker transport does not support session events.",
          ),
        );
      }
      return transport.subscribe(sessionId, cursor, onEvent);
    },
    writeSessionInput: (sessionId, attachmentId, data) =>
      transport.request("sessions.input", { sessionId, attachmentId, data }),
    resizeSession: (sessionId, attachmentId, size) =>
      transport.request("sessions.resize", { sessionId, attachmentId, size }),
    terminateSession: (sessionId, attachmentId, confirmed) =>
      transport.request("sessions.terminate", {
        sessionId,
        attachmentId,
        confirmed,
      }),
    getAiContext: (workspaceId) =>
      transport.request("ai.context", { workspaceId }),
    listRemoteGrants: () => transport.request("remote-grants.list", {}),
    createRemoteGrant: (grant) =>
      transport.request("remote-grants.create", { grant }),
    revokeRemoteGrant: (id) =>
      transport.request("remote-grants.revoke", { id }),
  };
}

export interface HttpBrokerTransportOptions {
  baseUrl: string;
  /** Return a short-lived relay token; never store it in this package. */
  accessToken?: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  requestId?: () => string;
}

export function createHttpBrokerTransport({
  baseUrl,
  accessToken,
  fetchImpl = globalThis.fetch,
  requestId = () => crypto.randomUUID(),
}: HttpBrokerTransportOptions): BrokerTransport {
  let endpoint: URL;
  try {
    endpoint = new URL(
      "v1/rpc",
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    );
  } catch {
    throw new BrokerTransportError(
      "invalid_endpoint",
      "Broker endpoint must be a valid URL.",
    );
  }
  if (!/^https?:$/.test(endpoint.protocol)) {
    throw new BrokerTransportError(
      "invalid_endpoint",
      "Broker endpoint must use HTTPS or HTTP for local development.",
    );
  }
  if (!fetchImpl)
    throw new BrokerTransportError(
      "missing_fetch",
      "This runtime does not provide fetch.",
    );

  return {
    async request<TResult, TPayload>(
      operation: BrokerOperation,
      payload: TPayload,
    ) {
      const id = requestId();
      const request: BrokerRequest<TPayload> = {
        protocolVersion: BROKER_PROTOCOL_VERSION,
        requestId: id,
        operation,
        payload,
      };
      const token = accessToken ? await accessToken() : undefined;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(request),
        });
      } catch (error) {
        throw new BrokerTransportError(
          "network_error",
          error instanceof Error
            ? error.message
            : "Broker request could not be sent.",
          true,
        );
      }
      if (!response.ok) {
        throw new BrokerTransportError(
          "http_error",
          `Broker request failed with HTTP ${response.status}.`,
          response.status >= 500,
        );
      }
      let envelope: Partial<BrokerResponse<TResult>>;
      try {
        envelope = (await response.json()) as Partial<BrokerResponse<TResult>>;
      } catch {
        throw new BrokerTransportError(
          "invalid_response",
          "Broker response was not valid JSON.",
        );
      }
      if (
        envelope.protocolVersion !== BROKER_PROTOCOL_VERSION ||
        envelope.requestId !== id
      ) {
        throw new BrokerTransportError(
          "protocol_mismatch",
          "Broker response did not match the request protocol or ID.",
        );
      }
      if (envelope.ok === false && envelope.error) {
        throw new BrokerTransportError(
          envelope.error.code,
          envelope.error.message,
          envelope.error.retryable,
        );
      }
      if (envelope.ok !== true || !("result" in envelope)) {
        throw new BrokerTransportError(
          "invalid_response",
          "Broker response was not a valid result envelope.",
        );
      }
      return envelope.result as TResult;
    },
  };
}

export { createBrokerClient as createRemoteBrokerClient };
export { BrokerTransportError } from "./errors";
export {
  createWebSocketBrokerTransport,
  type BrokerSocket,
  type BrokerSocketConstructor,
  type WebSocketBrokerTransport,
  type WebSocketBrokerTransportOptions,
} from "./websocket";
