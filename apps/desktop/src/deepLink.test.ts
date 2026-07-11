import { describe, expect, it } from "vitest";
import { resolveDeepLinkTarget } from "./deepLink";
import type { Session, Workspace } from "@term-dock/broker-contract";

const workspace: Workspace = {
  id: "ws-1",
  name: "Demo",
  directory: "/tmp/demo",
  shell: "/bin/zsh",
  startupCommands: [],
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const session: Session = {
  id: "sess-1",
  workspaceId: workspace.id,
  state: "running",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  outputPreview: "ready",
  cursor: 1,
  outputTruncated: false,
};

describe("deep-link resolution", () => {
  it("opens a valid session only within its own workspace", () => {
    expect(
      resolveDeepLinkTarget(
        { workspaceId: workspace.id, sessionId: session.id },
        [workspace],
        [session],
      ),
    ).toEqual({
      kind: "session",
      workspaceId: workspace.id,
      sessionId: session.id,
    });
  });

  it("offers recovery when the workspace or session is unavailable", () => {
    expect(
      resolveDeepLinkTarget({ workspaceId: "missing" }, [workspace], []),
    ).toMatchObject({ kind: "unavailable" });
    expect(
      resolveDeepLinkTarget(
        { workspaceId: workspace.id, sessionId: "missing" },
        [workspace],
        [session],
      ),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("does not attach an exited or disconnected session", () => {
    expect(
      resolveDeepLinkTarget(
        { workspaceId: workspace.id, sessionId: session.id },
        [workspace],
        [{ ...session, state: "exited" }],
      ),
    ).toMatchObject({ kind: "unavailable" });
  });
});
