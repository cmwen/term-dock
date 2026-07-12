import type {
  AiContext,
  BrokerOperation,
  CreateWorkspace,
  DeepLinkTarget,
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
import { createBrokerClient } from "@term-dock/broker-client";

export const isNativeHost = "__TAURI_INTERNALS__" in window;

const iso = (offsetMinutes = 0) =>
  new Date(Date.now() - offsetMinutes * 60_000).toISOString();
const demoWorkspace: Workspace = {
  id: "ws-term-dock",
  name: "Term Dock",
  directory: "/Users/dev/projects/term-dock",
  shell: "/bin/zsh",
  startupCommands: ["npm run dev"],
  archived: false,
  createdAt: iso(60 * 24 * 3),
  updatedAt: iso(4),
};
let demoWorkspaces: Workspace[] = [
  demoWorkspace,
  {
    ...demoWorkspace,
    id: "ws-api",
    name: "API migration",
    directory: "/Users/dev/projects/api",
    startupCommands: ["pnpm dev"],
    updatedAt: iso(42),
  },
];
let demoSessions: Session[] = [
  {
    id: "sess-demo",
    workspaceId: "ws-term-dock",
    state: "attention",
    startedAt: iso(85),
    lastActivityAt: iso(4),
    outputPreview: "? Continue with migration? (y/N)",
    cursor: 1,
    outputTruncated: false,
    activity: {
      state: "attention",
      confidence: "inference",
      reason: "Explicit confirmation prompt in terminal output",
    },
  },
];
let demoRemoteGrants: RemoteGrantSummary[] = [];
/** Runtime-only controller capabilities mirror the native broker's leases. */
const demoControllerAttachments = new Map<string, string>();
const demoInputBuffers = new Map<string, string>();
const demoSessionSubscribers = new Map<
  string,
  Set<(event: SessionEvent) => void>
>();

function publishDemoOutput(sessionId: string, data: string) {
  let emitted: SessionEvent | undefined;
  demoSessions = demoSessions.map((session) => {
    if (session.id !== sessionId) return session;
    const cursor = session.cursor + 1;
    emitted = { type: "output", sessionId, cursor, data };
    return {
      ...session,
      state: "running",
      cursor,
      outputPreview: `${session.outputPreview}${data}`.slice(-2_000),
      lastActivityAt: iso(),
      activity: {
        state: "running",
        confidence: "fact",
        reason: "Recent terminal output",
      },
    };
  });
  if (!emitted) return;
  for (const subscriber of demoSessionSubscribers.get(sessionId) ?? []) {
    subscriber(emitted);
  }
}

function subscribeDemoSession(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
) {
  const subscribers = demoSessionSubscribers.get(sessionId) ?? new Set();
  subscribers.add(onEvent);
  demoSessionSubscribers.set(sessionId, subscribers);
  return () => {
    subscribers.delete(onEvent);
    if (subscribers.size === 0) demoSessionSubscribers.delete(sessionId);
  };
}

function requireDemoController(sessionId: string, attachmentId: unknown) {
  if (
    typeof attachmentId !== "string" ||
    demoControllerAttachments.get(sessionId) !== attachmentId
  ) {
    throw new Error("Controller attachment is not authorized for this session");
  }
}

async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isNativeHost) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(command, args);
  }
  return demoInvoke<T>(command, args);
}

async function demoInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case "list_workspaces":
      return demoWorkspaces.filter((item) => !item.archived) as T;
    case "list_sessions":
      return demoSessions as T;
    case "create_workspace": {
      const input = args?.workspace as Omit<
        Workspace,
        "id" | "createdAt" | "updatedAt" | "archived"
      >;
      const workspace: Workspace = {
        ...input,
        id: crypto.randomUUID(),
        archived: false,
        createdAt: iso(),
        updatedAt: iso(),
      };
      demoWorkspaces = [workspace, ...demoWorkspaces];
      return workspace as T;
    }
    case "update_workspace": {
      const id = args?.id as string;
      const input = args?.workspace as CreateWorkspace;
      const updated = demoWorkspaces.find((item) => item.id === id);
      if (!updated) throw new Error("Workspace not found");
      const workspace: Workspace = {
        ...updated,
        ...input,
        updatedAt: iso(),
      };
      demoWorkspaces = demoWorkspaces.map((item) =>
        item.id === id ? workspace : item,
      );
      return workspace as T;
    }
    case "archive_workspace": {
      const id = args?.id as string;
      demoWorkspaces = demoWorkspaces.map((item) =>
        item.id === id ? { ...item, archived: true } : item,
      );
      return undefined as T;
    }
    case "launch_workspace": {
      const workspaceId = args?.workspaceId as string;
      const session: Session = {
        id: crypto.randomUUID(),
        workspaceId,
        state: "running",
        startedAt: iso(),
        lastActivityAt: iso(),
        outputPreview: "Term Dock preview shell ready.\r\n$ ",
        cursor: 0,
        outputTruncated: false,
        activity: {
          state: "running",
          confidence: "fact",
          reason: "PTY started",
        },
      };
      demoSessions = [session, ...demoSessions];
      return session as T;
    }
    case "get_ai_context": {
      const workspaceId = args?.workspaceId as string;
      const workspace =
        demoWorkspaces.find((item) => item.id === workspaceId) ?? demoWorkspace;
      return {
        version: "term-dock.ai-context/v1",
        workspace: {
          id: workspace.id,
          name: workspace.name,
          directory: workspace.directory,
          shell: workspace.shell,
          sshTarget: workspace.sshTarget,
        },
        sessions: demoSessions
          .filter((item) => item.workspaceId === workspace.id)
          .map(({ id, state, startedAt, lastActivityAt, exitCode }) => ({
            id,
            state,
            startedAt,
            lastActivityAt,
            exitCode,
          })),
        privacy: {
          terminalOutputIncluded: false,
          secretsIncluded: false,
          generatedLocally: true,
        },
        suggestedPrompt: `Help me continue work in ${workspace.name}. Ask before suggesting commands that modify files or processes.`,
      } satisfies AiContext as T;
    }
    case "attach_session": {
      const sessionId = args?.sessionId as string;
      const session = demoSessions.find((item) => item.id === sessionId);
      if (!session) throw new Error("Session not found");
      const access = args?.access as SessionAccess;
      if (access === "control" && demoControllerAttachments.has(sessionId)) {
        throw new Error("Session already has an active controller attachment");
      }
      const attachmentId =
        access === "control" ? `attach_${crypto.randomUUID()}` : undefined;
      if (attachmentId) demoControllerAttachments.set(sessionId, attachmentId);
      return {
        protocolVersion: "term-dock.broker/v1",
        session,
        access,
        attachmentId,
        cursor: session.cursor,
        output: session.outputPreview,
        outputTruncated: session.outputTruncated,
      } satisfies SessionAttachment as T;
    }
    case "replay_session_events": {
      const sessionId = args?.sessionId as string;
      const session = demoSessions.find((item) => item.id === sessionId);
      if (!session) throw new Error("Session not found");
      return {
        events: [],
        latestCursor: session.cursor,
        truncated: false,
      } satisfies SessionEventReplay as T;
    }
    case "detach_session": {
      const sessionId = args?.sessionId as string;
      requireDemoController(sessionId, args?.attachmentId);
      demoControllerAttachments.delete(sessionId);
      demoInputBuffers.delete(sessionId);
      return undefined as T;
    }
    case "list_remote_grants":
      return demoRemoteGrants as T;
    case "create_remote_grant": {
      const input = args?.grant as CreateRemoteGrant;
      const grant: RemoteGrantSummary = {
        id: `grant_${crypto.randomUUID()}`,
        deviceLabel: input.deviceLabel,
        access: input.access,
        createdAt: iso(),
        expiresAt: input.expiresAt,
        consumedAt: undefined,
      };
      demoRemoteGrants = [...demoRemoteGrants, grant];
      return {
        grant,
        secret: `tdg_preview_${crypto.randomUUID()}`,
      } satisfies IssuedRemoteGrant as T;
    }
    case "revoke_remote_grant": {
      const id = args?.id as string;
      demoRemoteGrants = demoRemoteGrants.filter((grant) => grant.id !== id);
      return undefined as T;
    }
    case "write_session_input": {
      const sessionId = args?.sessionId as string;
      requireDemoController(sessionId, args?.attachmentId);
      const data = args?.data as string;
      const priorInput = demoInputBuffers.get(sessionId) ?? "";
      const submitted = `${priorInput}${data}`;
      if (/[\r\n]/.test(data)) {
        const command = submitted.replace(/[\r\n]/g, "").trim();
        demoInputBuffers.delete(sessionId);
        publishDemoOutput(
          sessionId,
          `\r\npreview received: ${command || "(empty command)"}\r\n$ `,
        );
      } else {
        demoInputBuffers.set(sessionId, submitted);
        // A PTY echoes typed characters. Keeping the preview transport honest
        // makes browser E2E exercise the same renderer event path.
        publishDemoOutput(sessionId, data);
      }
      return undefined as T;
    }
    case "resize_session": {
      requireDemoController(args?.sessionId as string, args?.attachmentId);
      return undefined as T;
    }
    case "terminate_session": {
      if (args?.confirmed !== true)
        throw new Error("Termination requires explicit confirmation");
      const sessionId = args?.sessionId as string;
      requireDemoController(sessionId, args?.attachmentId);
      demoSessions = demoSessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              state: "exited",
              lastActivityAt: iso(),
              cursor: session.cursor + 1,
              activity: {
                state: "exited",
                confidence: "fact",
                reason: "PTY child process exited",
              },
            }
          : session,
      );
      demoControllerAttachments.delete(sessionId);
      demoInputBuffers.delete(sessionId);
      return undefined as T;
    }
    case "parse_deep_link": {
      const url = new URL(args?.url as string);
      return {
        workspaceId: url.pathname.split("/").filter(Boolean).at(-1),
        sessionId: url.searchParams.get("session") ?? undefined,
      } as T;
    }
    default:
      throw new Error(`Preview adapter does not implement ${command}`);
  }
}

const nativeBrokerOperation: Record<BrokerOperation, string> = {
  "workspaces.list": "list_workspaces",
  "workspaces.create": "create_workspace",
  "workspaces.update": "update_workspace",
  "workspaces.archive": "archive_workspace",
  "sessions.list": "list_sessions",
  "sessions.launch": "launch_workspace",
  "sessions.attach": "attach_session",
  "sessions.replay": "replay_session_events",
  "sessions.detach": "detach_session",
  "sessions.input": "write_session_input",
  "sessions.resize": "resize_session",
  "sessions.terminate": "terminate_session",
  "ai.context": "get_ai_context",
  "remote-grants.list": "list_remote_grants",
  "remote-grants.create": "create_remote_grant",
  "remote-grants.revoke": "revoke_remote_grant",
};

const broker = createBrokerClient({
  request: <TResult, TPayload>(operation: BrokerOperation, payload: TPayload) =>
    invoke<TResult>(
      nativeBrokerOperation[operation],
      payload as Record<string, unknown>,
    ),
  subscribe: async (sessionId, cursor, onEvent) => {
    if (!isNativeHost) return subscribeDemoSession(sessionId, onEvent);
    const { listen } = await import("@tauri-apps/api/event");
    let latestCursor = cursor;
    let replayComplete = false;
    const buffered: SessionEvent[] = [];
    const deliver = (payload: SessionEvent) => {
      if (payload.sessionId !== sessionId || payload.cursor <= latestCursor)
        return;
      latestCursor = payload.cursor;
      onEvent(payload);
    };
    const unlisten = await listen<SessionEvent>(
      "session-event",
      ({ payload }) => {
        if (!replayComplete) buffered.push(payload);
        else deliver(payload);
      },
    );
    try {
      const replay = await invoke<SessionEventReplay>("replay_session_events", {
        sessionId,
        cursor,
      });
      if (replay.truncated) {
        unlisten();
        throw new Error(
          "Session replay expired; reconnect to refresh its snapshot.",
        );
      }
      for (const event of [...replay.events, ...buffered].sort(
        (left, right) => left.cursor - right.cursor,
      )) {
        deliver(event);
      }
      replayComplete = true;
      return unlisten;
    } catch (error) {
      unlisten();
      throw error;
    }
  },
});

export const api = {
  listWorkspaces: () => broker.listWorkspaces(),
  listSessions: () => broker.listSessions(),
  createWorkspace: (workspace: CreateWorkspace) =>
    broker.createWorkspace(workspace),
  updateWorkspace: (id: string, workspace: CreateWorkspace) =>
    broker.updateWorkspace(id, workspace),
  archiveWorkspace: (id: string) => broker.archiveWorkspace(id),
  launchWorkspace: (workspaceId: string) => broker.launchWorkspace(workspaceId),
  listRemoteGrants: () => broker.listRemoteGrants(),
  createRemoteGrant: (grant: CreateRemoteGrant) =>
    broker.createRemoteGrant(grant),
  revokeRemoteGrant: (id: string) => broker.revokeRemoteGrant(id),
  attachSession: (sessionId: string, access: SessionAccess) =>
    broker.attachSession(sessionId, access),
  replaySessionEvents: (sessionId: string, cursor: number) =>
    broker.replaySessionEvents(sessionId, cursor),
  detachSession: (sessionId: string, attachmentId: string) =>
    broker.detachSession(sessionId, attachmentId),
  subscribeSession: (
    sessionId: string,
    cursor: number,
    onEvent: (event: SessionEvent) => void,
  ) => broker.subscribeSession(sessionId, cursor, onEvent),
  writeSessionInput: (sessionId: string, attachmentId: string, data: string) =>
    broker.writeSessionInput(sessionId, attachmentId, data),
  resizeSession: (
    sessionId: string,
    attachmentId: string,
    size: TerminalSize,
  ) => broker.resizeSession(sessionId, attachmentId, size),
  terminateSession: (
    sessionId: string,
    attachmentId: string,
    confirmed: boolean,
  ) => broker.terminateSession(sessionId, attachmentId, confirmed),
  getAiContext: (workspaceId: string) => broker.getAiContext(workspaceId),
  parseDeepLink: (url: string) =>
    invoke<DeepLinkTarget>("parse_deep_link", { url }),
};
