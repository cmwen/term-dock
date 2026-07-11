import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  createBrokerClient,
  createWebSocketBrokerTransport,
  type BrokerClient,
  type WebSocketBrokerTransport,
} from "@term-dock/broker-client";
import type {
  Session,
  SessionAccess,
  Workspace,
} from "@term-dock/broker-contract";

const TerminalView = lazy(() =>
  import("@term-dock/terminal-view").then(({ TerminalView }) => ({
    default: TerminalView,
  })),
);

const configuredEndpoint = import.meta.env.VITE_TERM_DOCK_RELAY_URL ?? "";

export default function App() {
  const transport = useRef<WebSocketBrokerTransport | undefined>(undefined);
  const [endpoint, setEndpoint] = useState(configuredEndpoint);
  const [token, setToken] = useState("");
  const [client, setClient] = useState<BrokerClient>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [attachedSessionId, setAttachedSessionId] = useState<string>();
  const [access, setAccess] = useState<SessionAccess>("view");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(
    () => () => {
      transport.current?.close();
    },
    [],
  );

  const selected = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedId),
    [selectedId, workspaces],
  );
  const selectedSessions = useMemo(
    () => sessions.filter((session) => session.workspaceId === selectedId),
    [selectedId, sessions],
  );

  async function refresh(activeClient: BrokerClient) {
    const [nextWorkspaces, nextSessions] = await Promise.all([
      activeClient.listWorkspaces(),
      activeClient.listSessions(),
    ]);
    setWorkspaces(nextWorkspaces);
    setSessions(nextSessions);
    setSelectedId((current) =>
      current && nextWorkspaces.some((workspace) => workspace.id === current)
        ? current
        : nextWorkspaces[0]?.id,
    );
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setError(undefined);
    const shortLivedToken = token;
    let nextTransport: WebSocketBrokerTransport | undefined;
    try {
      nextTransport = createWebSocketBrokerTransport({
        url: endpoint,
        accessToken: shortLivedToken ? () => shortLivedToken : undefined,
      });
      const nextClient = createBrokerClient(nextTransport);
      await refresh(nextClient);
      transport.current?.close();
      transport.current = nextTransport;
      setClient(nextClient);
      setToken("");
    } catch (cause) {
      nextTransport?.close();
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the remote companion.",
      );
    } finally {
      setConnecting(false);
    }
  }

  function disconnect() {
    transport.current?.close();
    transport.current = undefined;
    setClient(undefined);
    setWorkspaces([]);
    setSessions([]);
    setSelectedId(undefined);
    setAttachedSessionId(undefined);
  }

  if (!client) {
    return (
      <main className="connect-shell">
        <section className="connect-card">
          <p className="eyebrow">TERM DOCK REMOTE</p>
          <h1>Open your Term Dock remotely</h1>
          <p>
            Connect to your authenticated companion. This browser never owns a
            shell, filesystem, enrollment secret, or stored token.
          </p>
          <form onSubmit={(event) => void connect(event)}>
            <label>
              Relay WebSocket endpoint
              <input
                required
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="wss://relay.example.com/term-dock"
              />
            </label>
            <label>
              Short-lived access token
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Optional for local development"
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <p className="note">
              The token is sent in the first WebSocket auth frame and is never
              stored in this web app or placed in a URL.
            </p>
            <button type="submit" disabled={connecting}>
              {connecting ? "Connecting…" : "Connect securely"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="remote-shell">
      <aside>
        <div className="remote-brand">term dock remote</div>
        <button type="button" className="disconnect" onClick={disconnect}>
          Disconnect
        </button>
        <p>WORKSPACES</p>
        <nav aria-label="Remote workspaces">
          {workspaces.map((workspace) => (
            <button
              type="button"
              className={workspace.id === selectedId ? "selected" : ""}
              key={workspace.id}
              onClick={() => {
                setSelectedId(workspace.id);
                setAttachedSessionId(undefined);
              }}
            >
              {workspace.name}
            </button>
          ))}
        </nav>
      </aside>
      <section className="remote-content">
        {selected ? (
          <>
            <header>
              <div>
                <p className="eyebrow">REMOTE WORKSPACE</p>
                <h1>{selected.name}</h1>
                <p>{selected.directory}</p>
              </div>
              <button type="button" onClick={() => void refresh(client)}>
                Refresh
              </button>
            </header>
            <section className="session-panel">
              <h2>Durable sessions</h2>
              {selectedSessions.length ? (
                selectedSessions.map((session) => (
                  <div className="remote-session" key={session.id}>
                    <div>
                      <strong>{session.state}</strong>
                      <p>{session.outputPreview || "No output yet."}</p>
                      {session.activity && (
                        <small>
                          {session.activity.confidence === "inference"
                            ? "Inference"
                            : "Observed fact"}
                          {" · "}
                          {session.activity.reason}
                        </small>
                      )}
                    </div>
                    <div className="session-actions">
                      <button
                        type="button"
                        disabled={
                          session.state === "exited" ||
                          session.state === "disconnected"
                        }
                        onClick={() => {
                          setAccess("view");
                          setAttachedSessionId(session.id);
                        }}
                      >
                        View
                      </button>
                      <button
                        type="button"
                        disabled={
                          session.state === "exited" ||
                          session.state === "disconnected"
                        }
                        onClick={() => {
                          setAccess("control");
                          setAttachedSessionId(session.id);
                        }}
                      >
                        Request control
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p>No remote sessions are available for this workspace.</p>
              )}
            </section>
            {attachedSessionId && (
              <Suspense
                fallback={
                  <p className="terminal-loading">Preparing terminal…</p>
                }
              >
                <TerminalView
                  client={client}
                  sessionId={attachedSessionId}
                  workspace={selected}
                  access={access}
                  onClose={() => setAttachedSessionId(undefined)}
                  onTerminated={() => {
                    setAttachedSessionId(undefined);
                    void refresh(client);
                  }}
                />
              </Suspense>
            )}
          </>
        ) : (
          <p>No remote workspace is available.</p>
        )}
      </section>
    </main>
  );
}
