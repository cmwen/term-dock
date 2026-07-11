import { describe, expect, it } from "vitest";
import type {
  Session,
  SessionEvent,
  Workspace,
} from "@term-dock/broker-contract";
import { notificationForSessionEvent } from "./index";

const workspace: Workspace = {
  id: "ws-term-dock",
  name: "Term Dock",
  directory: "/private/work/term-dock",
  shell: "/bin/zsh",
  startupCommands: [],
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const session: Session = {
  id: "sess-1",
  workspaceId: workspace.id,
  state: "attention",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:01:00.000Z",
  outputPreview: "super-secret terminal output",
  cursor: 9,
  outputTruncated: false,
};

describe("notification policy", () => {
  it("creates a privacy-safe attention notification from a state event", () => {
    const event: SessionEvent = {
      type: "state",
      sessionId: session.id,
      cursor: 10,
      state: "attention",
    };

    const notification = notificationForSessionEvent(event, session, workspace);

    expect(notification).toEqual({
      id: "session:sess-1:10",
      kind: "attention",
      sessionId: "sess-1",
      workspaceId: "ws-term-dock",
      title: "Term Dock needs attention",
      body: "A terminal session may be waiting for input.",
    });
    expect(JSON.stringify(notification)).not.toContain("super-secret");
    expect(JSON.stringify(notification)).not.toContain("/private/work");
  });

  it("only notifies for attention or exit state changes", () => {
    const output: SessionEvent = {
      type: "output",
      sessionId: session.id,
      cursor: 10,
      data: "(y/N)",
    };
    const running: SessionEvent = {
      type: "state",
      sessionId: session.id,
      cursor: 11,
      state: "running",
    };
    const exited: SessionEvent = {
      type: "state",
      sessionId: session.id,
      cursor: 12,
      state: "exited",
    };

    expect(
      notificationForSessionEvent(output, session, workspace),
    ).toBeUndefined();
    expect(
      notificationForSessionEvent(running, session, workspace),
    ).toBeUndefined();
    expect(
      notificationForSessionEvent(exited, session, workspace),
    ).toMatchObject({
      kind: "exited",
      body: "Open Term Dock to review the session.",
    });
  });
});
