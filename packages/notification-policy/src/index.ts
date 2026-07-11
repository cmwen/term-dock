import type {
  Session,
  SessionEvent,
  Workspace,
} from "@term-dock/broker-contract";

/** A presentation-safe alert that contains no terminal output or secrets. */
export interface SessionNotification {
  id: string;
  kind: "attention" | "exited";
  sessionId: string;
  workspaceId: string;
  title: string;
  body: string;
}

/**
 * Maps authoritative broker state changes to a small, privacy-safe alert.
 * Delivery belongs to the platform client (native, browser, or remote), not
 * to the broker and never requires forwarding terminal bytes.
 */
export function notificationForSessionEvent(
  event: SessionEvent,
  session: Session,
  workspace: Workspace,
): SessionNotification | undefined {
  if (
    event.type !== "state" ||
    event.sessionId !== session.id ||
    session.workspaceId !== workspace.id
  ) {
    return undefined;
  }

  switch (event.state) {
    case "attention":
      return {
        id: `session:${event.sessionId}:${event.cursor}`,
        kind: "attention",
        sessionId: session.id,
        workspaceId: workspace.id,
        title: `${workspace.name} needs attention`,
        body: "A terminal session may be waiting for input.",
      };
    case "exited":
      return {
        id: `session:${event.sessionId}:${event.cursor}`,
        kind: "exited",
        sessionId: session.id,
        workspaceId: workspace.id,
        title: `${workspace.name} session exited`,
        body: "Open Term Dock to review the session.",
      };
    default:
      return undefined;
  }
}
