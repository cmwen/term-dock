import type {
  DeepLinkTarget,
  Session,
  Workspace,
} from "@term-dock/broker-contract";

export type DeepLinkResolution =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "session"; workspaceId: string; sessionId: string }
  | { kind: "unavailable"; message: string };

/**
 * Links only navigate to already-authorized local records. A session target
 * must belong to the requested workspace and still be attachable here.
 */
export function resolveDeepLinkTarget(
  target: DeepLinkTarget,
  workspaces: Workspace[],
  sessions: Session[],
): DeepLinkResolution {
  const workspace = workspaces.find((item) => item.id === target.workspaceId);
  if (!workspace) {
    return {
      kind: "unavailable",
      message:
        "This workspace is not available on this device. Create or restore it before opening the link.",
    };
  }
  if (!target.sessionId) {
    return { kind: "workspace", workspaceId: workspace.id };
  }
  const session = sessions.find((item) => item.id === target.sessionId);
  if (!session || session.workspaceId !== workspace.id) {
    return {
      kind: "unavailable",
      message:
        "This session is unavailable for the requested workspace. Select the workspace to launch a new session.",
    };
  }
  if (session.state === "exited" || session.state === "disconnected") {
    return {
      kind: "unavailable",
      message:
        "This session cannot be reattached on this device. Select the workspace to launch a new session.",
    };
  }
  return {
    kind: "session",
    workspaceId: workspace.id,
    sessionId: session.id,
  };
}
