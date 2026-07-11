import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  BellRing,
  Bot,
  CircleDot,
  Copy,
  FolderPlus,
  Pencil,
  Play,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { api, isNativeHost } from "./api";
import { resolveDeepLinkTarget } from "./deepLink";
import {
  desktopAlertsAreEnabled,
  requestDesktopAlerts,
  sendDesktopAlert,
} from "./notifications";
import { notificationForSessionEvent } from "@term-dock/notification-policy";
import type {
  AiContext,
  CreateWorkspace,
  IssuedRemoteGrant,
  RemoteGrantSummary,
  Session,
  SessionAccess,
  SessionEvent,
  SessionState,
  Workspace,
} from "@term-dock/broker-contract";

const TerminalPane = lazy(() => import("./TerminalPane"));

const stateLabel: Record<SessionState, string> = {
  running: "Active",
  quiet: "Quiet",
  attention: "Needs attention",
  exited: "Exited",
  disconnected: "Disconnected",
};

function relativeTime(value: string) {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 60_000),
  );
  return minutes < 1
    ? "just now"
    : minutes === 1
      ? "1 min ago"
      : `${minutes} min ago`;
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [aiContext, setAiContext] = useState<AiContext>();
  const [attachedSessionId, setAttachedSessionId] = useState<string>();
  const [showRemoteAccess, setShowRemoteAccess] = useState(false);
  const [remoteGrants, setRemoteGrants] = useState<RemoteGrantSummary[]>([]);
  const [error, setError] = useState<string>();
  const [desktopAlertsEnabled, setDesktopAlertsEnabled] = useState(false);
  const latestWorkspaceState = useRef({
    workspaces,
    sessions,
    attachedSessionId,
  });
  const notifiedSessionEvents = useRef(new Set<string>());
  latestWorkspaceState.current = { workspaces, sessions, attachedSessionId };

  const refresh = useCallback(async () => {
    try {
      const [nextWorkspaces, nextSessions] = await Promise.all([
        api.listWorkspaces(),
        api.listSessions(),
      ]);
      setWorkspaces(nextWorkspaces);
      setSessions(nextSessions);
      setSelectedId((current) =>
        current && nextWorkspaces.some((workspace) => workspace.id === current)
          ? current
          : nextWorkspaces[0]?.id,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load the local workspace registry.",
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    if (!isNativeHost) return;
    void desktopAlertsAreEnabled().then(setDesktopAlertsEnabled);
  }, []);

  useEffect(() => {
    if (!isNativeHost || !desktopAlertsEnabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const stop = await listen<SessionEvent>(
          "session-event",
          ({ payload }) => {
            if (payload.type !== "state") return;
            void refresh();
            const current = latestWorkspaceState.current;
            if (payload.sessionId === current.attachedSessionId) return;
            const session = current.sessions.find(
              (item) => item.id === payload.sessionId,
            );
            const workspace = session
              ? current.workspaces.find(
                  (item) => item.id === session.workspaceId,
                )
              : undefined;
            if (!session || !workspace) return;
            const notification = notificationForSessionEvent(
              payload,
              session,
              workspace,
            );
            if (
              !notification ||
              notifiedSessionEvents.current.has(notification.id)
            ) {
              return;
            }
            notifiedSessionEvents.current.add(notification.id);
            void sendDesktopAlert(notification).catch(() => undefined);
          },
        );
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopAlertsEnabled, refresh]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    const resolve = async (url: string) => {
      try {
        const target = await api.parseDeepLink(url);
        const [nextWorkspaces, nextSessions] = await Promise.all([
          api.listWorkspaces(),
          api.listSessions(),
        ]);
        setWorkspaces(nextWorkspaces);
        setSessions(nextSessions);
        const resolution = resolveDeepLinkTarget(
          target,
          nextWorkspaces,
          nextSessions,
        );
        if (resolution.kind === "unavailable") {
          setAttachedSessionId(undefined);
          setError(resolution.message);
          return;
        }
        setError(undefined);
        setSelectedId(resolution.workspaceId);
        setAiContext(undefined);
        setAttachedSessionId(
          resolution.kind === "session" ? resolution.sessionId : undefined,
        );
      } catch {
        setError("This link is not a valid Term Dock workspace link.");
      }
    };
    void import("@tauri-apps/plugin-deep-link")
      .then(async ({ getCurrent, onOpenUrl }) => {
        const urls = await getCurrent();
        if (urls) await Promise.all(urls.map(resolve));
        unlisten = await onOpenUrl((urls) => {
          void Promise.all(urls.map(resolve));
        });
      })
      .catch(() => setError("Deep-link integration could not start."));
    return () => {
      unlisten?.();
    };
  }, []);

  const visible = useMemo(
    () =>
      workspaces.filter(
        (workspace) =>
          workspace.name.toLowerCase().includes(search.toLowerCase()) ||
          workspace.directory.toLowerCase().includes(search.toLowerCase()),
      ),
    [workspaces, search],
  );
  const selected = workspaces.find((workspace) => workspace.id === selectedId);
  const selectedSessions = sessions.filter(
    (session) => session.workspaceId === selectedId,
  );
  const resumableSession = selectedSessions.find(
    (session) => session.state !== "exited" && session.state !== "disconnected",
  );

  async function launch(id: string) {
    const existing = sessions.find(
      (session) =>
        session.workspaceId === id &&
        session.state !== "exited" &&
        session.state !== "disconnected",
    );
    if (existing) {
      setAttachedSessionId(existing.id);
      return;
    }
    await api.launchWorkspace(id);
    await refresh();
  }
  async function create(input: CreateWorkspace) {
    const created = await api.createWorkspace(input);
    setSelectedId(created.id);
    setShowCreate(false);
    await refresh();
  }
  async function update(input: CreateWorkspace) {
    if (!selected) return;
    await api.updateWorkspace(selected.id, input);
    setShowEdit(false);
    await refresh();
  }
  async function archive() {
    if (!selected) return;
    await api.archiveWorkspace(selected.id);
    setAttachedSessionId(undefined);
    setAiContext(undefined);
    setShowArchive(false);
    await refresh();
  }
  async function copyAiContext() {
    if (!selected) return;
    const context = await api.getAiContext(selected.id);
    setAiContext(context);
    if (navigator.clipboard?.writeText)
      await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
  }
  async function openRemoteAccess() {
    setRemoteGrants(await api.listRemoteGrants());
    setShowRemoteAccess(true);
  }
  async function enableDesktopAlerts() {
    const enabled = await requestDesktopAlerts();
    setDesktopAlertsEnabled(enabled);
    if (!enabled) {
      setError(
        "Desktop alerts were not enabled. Check your operating-system notification settings.",
      );
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Terminal size={20} /> <span>term dock</span>
        </div>
        <button
          type="button"
          className="new-workspace"
          onClick={() => setShowCreate(true)}
        >
          <FolderPlus size={17} /> New workspace
        </button>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search workspaces"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search workspaces"
          />
        </label>
        <p className="section-label">WORKSPACES</p>
        <nav aria-label="Workspaces">
          {visible.map((workspace) => {
            const session = sessions.find(
              (item) =>
                item.workspaceId === workspace.id && item.state !== "exited",
            );
            return (
              <button
                type="button"
                key={workspace.id}
                className={`workspace-link ${workspace.id === selectedId ? "selected" : ""}`}
                onClick={() => {
                  setSelectedId(workspace.id);
                  setAiContext(undefined);
                  setAttachedSessionId(undefined);
                }}
              >
                <span className={`status-dot ${session?.state ?? "quiet"}`} />{" "}
                <span>{workspace.name}</span>
              </button>
            );
          })}
        </nav>
        {isNativeHost && (
          <button
            type="button"
            className="secondary notification-control"
            onClick={() => void enableDesktopAlerts()}
            disabled={desktopAlertsEnabled}
          >
            <BellRing size={16} />{" "}
            {desktopAlertsEnabled
              ? "Desktop alerts on"
              : "Enable desktop alerts"}
          </button>
        )}
        <div className="sidebar-foot">Local-first · no cloud shell</div>
      </aside>
      <section className="content">
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {selected ? (
          <>
            <header className="workspace-header">
              <div>
                <p className="eyebrow">WORKSPACE</p>
                <h1>{selected.name}</h1>
                <p className="path">{selected.directory}</p>
              </div>
              <div className="header-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setShowEdit(true)}
                >
                  <Pencil size={16} /> Edit workspace
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setShowArchive(true)}
                >
                  <Archive size={16} /> Archive
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void openRemoteAccess()}
                >
                  <ShieldCheck size={16} /> Remote access
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={copyAiContext}
                >
                  <Bot size={16} /> AI context
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void launch(selected.id)}
                >
                  <Play size={16} fill="currentColor" />{" "}
                  {resumableSession ? "Resume session" : "Launch session"}
                </button>
              </div>
            </header>
            <section className="summary-grid" aria-label="Workspace health">
              <Summary
                label="Sessions"
                value={String(selectedSessions.length)}
                detail={
                  selectedSessions.some((item) => item.state === "running")
                    ? "currently active"
                    : "no running sessions"
                }
              />
              <Summary
                label="Attention"
                value={String(
                  selectedSessions.filter((item) => item.state === "attention")
                    .length,
                )}
                detail="inferred, never assumed"
                tone="attention"
              />
              <Summary
                label="Connection"
                value={selected.sshTarget ? "SSH" : "Local"}
                detail={selected.sshTarget ?? "This device"}
              />
            </section>
            <section className="panel sessions-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">DURABLE SESSIONS</p>
                  <h2>Continue where you left off</h2>
                </div>
                <span className="fact-badge">
                  <CircleDot size={14} /> Facts + confidence
                </span>
              </div>
              {selectedSessions.length === 0 ? (
                <EmptySession onLaunch={() => void launch(selected.id)} />
              ) : (
                <div className="session-list">
                  {selectedSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      onOpen={() => setAttachedSessionId(session.id)}
                    />
                  ))}
                </div>
              )}
            </section>
            {attachedSessionId && (
              <Suspense
                fallback={
                  <div className="terminal-loading">
                    Preparing terminal renderer…
                  </div>
                }
              >
                <TerminalPane
                  sessionId={attachedSessionId}
                  workspace={selected}
                  onClose={() => setAttachedSessionId(undefined)}
                  onTerminated={() => {
                    setAttachedSessionId(undefined);
                    void refresh();
                  }}
                />
              </Suspense>
            )}
            <section className="ai-panel">
              <div className="ai-mark">
                <Bot size={21} />
              </div>
              <div>
                <p className="eyebrow">AI-READY, BY DEFAULT</p>
                <h2>Portable context without transcript leakage</h2>
                <p>
                  Copy a versioned, structured workspace brief for any
                  assistant. It excludes terminal output, credentials, and
                  commands.
                </p>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={copyAiContext}
              >
                <Copy size={16} /> Copy context
              </button>
            </section>
            {aiContext && (
              <section
                className="context-preview"
                aria-label="AI context preview"
              >
                <pre>{JSON.stringify(aiContext, null, 2)}</pre>
              </section>
            )}
          </>
        ) : (
          <div className="blank">
            <Terminal size={36} />
            <h1>Create your first workspace</h1>
            <p>
              Save a directory, then launch durable local sessions from one
              place.
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => setShowCreate(true)}
            >
              Create workspace
            </button>
          </div>
        )}
      </section>
      {showCreate && (
        <WorkspaceDialog onClose={() => setShowCreate(false)} onSave={create} />
      )}
      {showEdit && selected && (
        <WorkspaceDialog
          workspace={selected}
          onClose={() => setShowEdit(false)}
          onSave={update}
        />
      )}
      {showArchive && selected && (
        <ArchiveWorkspaceDialog
          workspace={selected}
          onClose={() => setShowArchive(false)}
          onArchive={archive}
        />
      )}
      {showRemoteAccess && (
        <RemoteAccessDialog
          grants={remoteGrants}
          onClose={() => setShowRemoteAccess(false)}
          onCreate={async (deviceLabel, access, expiresAt) => {
            const issued = await api.createRemoteGrant({
              deviceLabel,
              access,
              expiresAt,
            });
            setRemoteGrants(await api.listRemoteGrants());
            return issued;
          }}
          onRevoke={async (id) => {
            await api.revokeRemoteGrant(id);
            setRemoteGrants(await api.listRemoteGrants());
          }}
        />
      )}
    </main>
  );
}

function Summary({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className={`summary ${tone ?? ""}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}
function SessionRow({
  session,
  onOpen,
}: {
  session: Session;
  onOpen: () => void;
}) {
  const activity = session.activity ?? {
    confidence: session.state === "attention" ? "inference" : "fact",
    reason:
      session.state === "attention"
        ? "Session may be waiting for input"
        : "Broker session state",
  };
  return (
    <button type="button" className="session-row" onClick={onOpen}>
      <span className={`status-dot ${session.state}`} />
      <div className="session-main">
        <h3>{stateLabel[session.state]}</h3>
        <p>{session.outputPreview || "No output recorded yet."}</p>
      </div>
      <div className="session-meta">
        <span>{relativeTime(session.lastActivityAt)}</span>
        <small>
          {activity.confidence === "inference" ? "Inference" : "Observed fact"}
          {" · "}
          {activity.reason}
        </small>
      </div>
    </button>
  );
}
function EmptySession({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="empty-session">
      <Terminal size={22} />
      <p>No session is running for this workspace.</p>
      <button type="button" className="text-button" onClick={onLaunch}>
        Launch a durable session
      </button>
    </div>
  );
}

function WorkspaceDialog({
  workspace,
  onClose,
  onSave,
}: {
  workspace?: Workspace;
  onClose: () => void;
  onSave: (input: CreateWorkspace) => Promise<void>;
}) {
  const isEditing = Boolean(workspace);
  const [name, setName] = useState(workspace?.name ?? "");
  const [directory, setDirectory] = useState(workspace?.directory ?? "");
  const [shell, setShell] = useState(workspace?.shell ?? "/bin/zsh");
  const [sshTarget, setSshTarget] = useState(workspace?.sshTarget ?? "");
  const [commands, setCommands] = useState(
    workspace?.startupCommands.join("\n") ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        name,
        directory,
        shell,
        sshTarget: sshTarget.trim() || undefined,
        startupCommands: commands
          .split("\n")
          .map((command) => command.trim())
          .filter(Boolean),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save this workspace.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" onSubmit={(event) => void submit(event)}>
        <button
          type="button"
          className="close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <p className="eyebrow">
          {isEditing ? "EDIT WORKSPACE" : "NEW WORKSPACE"}
        </p>
        <h2>
          {isEditing
            ? "Update the next launch"
            : "Give terminal work a stable home"}
        </h2>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <label>
          Name
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My project"
          />
        </label>
        <label>
          {sshTarget.trim() ? "Remote directory" : "Local directory"}
          <input
            required
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="/Users/you/projects/my-project"
          />
        </label>
        <label>
          {sshTarget.trim() ? "Remote shell" : "Shell"}
          <input
            required
            value={shell}
            onChange={(event) => setShell(event.target.value)}
            placeholder="/bin/zsh"
          />
        </label>
        <label>
          SSH target <span>(optional alias)</span>
          <input
            value={sshTarget}
            onChange={(event) => setSshTarget(event.target.value)}
            placeholder="dev-box"
          />
        </label>
        {sshTarget.trim() && (
          <p className="form-note">
            This launches your installed OpenSSH client. Configure identity,
            port, jump host, and credentials in your SSH config or OS keychain.
          </p>
        )}
        <label>
          Startup commands <span>(one per line)</span>
          <textarea
            value={commands}
            onChange={(event) => setCommands(event.target.value)}
            placeholder="pnpm dev"
          />
        </label>
        <p className="form-note">
          Changes apply to the next launch. Existing durable sessions keep
          running unchanged.
        </p>
        <button type="submit" className="primary full" disabled={saving}>
          {saving
            ? isEditing
              ? "Saving…"
              : "Creating…"
            : isEditing
              ? "Save workspace"
              : "Create workspace"}
        </button>
      </form>
    </div>
  );
}

function ArchiveWorkspaceDialog({
  workspace,
  onClose,
  onArchive,
}: {
  workspace: Workspace;
  onClose: () => void;
  onArchive: () => Promise<void>;
}) {
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string>();

  async function archive() {
    setArchiving(true);
    setError(undefined);
    try {
      await onArchive();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not archive this workspace.",
      );
      setArchiving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" aria-label="Archive workspace">
        <button
          type="button"
          className="close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <p className="eyebrow">ARCHIVE WORKSPACE</p>
        <h2>Remove {workspace.name} from the dashboard?</h2>
        <p className="form-note">
          Archiving removes this saved workspace from the active dashboard. It
          does not terminate any existing terminal session.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Keep workspace
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void archive()}
            disabled={archiving}
          >
            {archiving ? "Archiving…" : "Archive workspace"}
          </button>
        </div>
      </section>
    </div>
  );
}

function RemoteAccessDialog({
  grants,
  onClose,
  onCreate,
  onRevoke,
}: {
  grants: RemoteGrantSummary[];
  onClose: () => void;
  onCreate: (
    deviceLabel: string,
    access: SessionAccess,
    expiresAt?: string,
  ) => Promise<IssuedRemoteGrant>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [deviceLabel, setDeviceLabel] = useState("");
  const [access, setAccess] = useState<SessionAccess>("view");
  const [expiry, setExpiry] = useState("");
  const [issued, setIssued] = useState<IssuedRemoteGrant>();
  const [saving, setSaving] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      setIssued(
        await onCreate(
          deviceLabel,
          access,
          expiry ? new Date(expiry).toISOString() : undefined,
        ),
      );
      setDeviceLabel("");
      setExpiry("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal remote-modal" aria-label="Remote access">
        <button
          type="button"
          className="close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <p className="eyebrow">REMOTE ACCESS</p>
        <h2>Prepare a device grant</h2>
        <p className="form-note">
          Remote transport is not enabled yet. This creates a scoped, revocable
          enrollment secret for a future authenticated companion.
        </p>
        <form onSubmit={(event) => void create(event)}>
          <label>
            Device label
            <input
              required
              value={deviceLabel}
              onChange={(event) => setDeviceLabel(event.target.value)}
              placeholder="Personal iPad"
            />
          </label>
          <label>
            Access scope
            <select
              value={access}
              onChange={(event) =>
                setAccess(event.target.value as SessionAccess)
              }
            >
              <option value="view">View only</option>
              <option value="control">Control terminal</option>
            </select>
          </label>
          <label>
            Expiry <span>(optional)</span>
            <input
              type="datetime-local"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
          </label>
          <button type="submit" className="primary full" disabled={saving}>
            {saving ? "Creating…" : "Create one-time grant"}
          </button>
        </form>
        {issued && (
          <div className="issued-grant" role="status">
            <strong>Copy this secret now—it will not be shown again.</strong>
            <code>{issued.secret}</code>
            <span>
              {issued.grant.access === "control" ? "Controller" : "Viewer"}{" "}
              grant for {issued.grant.deviceLabel}
            </span>
          </div>
        )}
        <div className="grant-list">
          <p className="eyebrow">ACTIVE DEVICE GRANTS</p>
          {grants.length === 0 ? (
            <p className="form-note">No device grants have been issued.</p>
          ) : (
            grants.map((grant) => (
              <div className="grant-row" key={grant.id}>
                <div>
                  <strong>{grant.deviceLabel}</strong>
                  <span>
                    {grant.access} ·{" "}
                    {grant.expiresAt
                      ? `expires ${new Date(grant.expiresAt).toLocaleString()}`
                      : "no expiry"}
                    {grant.consumedAt ? " · enrollment used" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void onRevoke(grant.id)}
                >
                  Revoke
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
