# Architecture

Term Dock is intentionally split into a replaceable presentation layer and a local authority layer:

```text
React/xterm client ── shared broker client ── Rust session broker ── PTY / shell
         │                        │                    └── local JSON registry
desktop Tauri adapter      web WebSocket adapter
```

The desktop host is the authority. It validates saved workspace definitions, resolves deep links, creates PTYs, holds process ownership, and stores its registry in the application-data directory. The React UI never receives a shell capability, filesystem capability, or secret. The desktop and browser clients attach only through the versioned session-broker contract described in [the protocol](PROTOCOL.md).

## MVP choices

- **Tauri 2 + React 19 + TypeScript:** a current, fast desktop stack with a small local authority surface. Vite supplies the UI build and test loop.
- **Portable PTY host:** the Rust host opens the PTY and retains the child process. Closing or replacing a UI view therefore cannot terminate a session by accident.
- **SSH-backed workspaces:** an SSH target launches the installed local OpenSSH client with a forced TTY inside the broker-owned PTY. Target data is restricted to an alias or `user@host`; remote paths and shell paths are POSIX-quoted, while authentication and transport policy remain in SSH configuration rather than the workspace registry.
- **Explicit termination:** ending a session is a separately confirmed broker operation. Archiving a workspace and closing a terminal view never invoke it.
- **Transport-neutral sessions:** attachment, input, resize, termination, and output events have a versioned contract. `BrokerClient.subscribeSession` is the streaming seam; Tauri events are only the local adapter, and no future browser should depend on Tauri APIs.
- **Shared xterm renderer:** `@term-dock/terminal-view` attaches through that contract in both desktop and `apps/web`, and visibly identifies the workspace, host, and directory for every terminal view.
- **Canonical controller size:** the shared renderer observes its layout and sends bounded resize updates only for a `control` attachment. Viewer attachments render terminal bytes without changing the PTY's canonical dimensions.
- **Exclusive controller lease:** a granted control attachment receives an opaque runtime-only capability. The Rust host requires it for input, resize, termination, and detach; it permits one controller per live PTY and releases the lease when the renderer closes. The capability is not persisted, routed through a URL, or exported to AI context.
- **Bounded replay:** the broker keeps the last 2,000 characters as valid UTF-8 for reconnect. A full encrypted scrollback store belongs behind the same interface.
- **Debounced durability:** active PTY readers checkpoint that bounded preview at most once per second and once more on reader shutdown. A serialized persistence lock keeps concurrent command, monitor, and reader writes ordered while avoiding an unbounded transcript on disk.
- **Cursor recovery:** each live host also retains a bounded, in-memory event window for `sessions.replay`. A client that detects a replay gap re-attaches for a new bounded snapshot; terminal output is never promoted to an unbounded persisted event log.
- **Authoritative lifecycle:** the Rust host polls each PTY child, records its exit code, emits a final state event, and marks active records `disconnected` on a later desktop restart. Clients never infer process liveness from stale registry data.
- **Lightweight monitoring:** after 30 seconds without output, a live session becomes `quiet` as an observed fact. Explicit confirmation prompts such as `(y/N)` may become `attention` as a low-confidence inference; generic shell prompts are deliberately ignored. Each state can carry portable `activity` metadata with its confidence and reason so desktop, web, and future remote clients explain it consistently.
- **Opt-in notification policy:** `@term-dock/notification-policy` converts only `attention` and `exited` broker state events into transcript-free notification candidates. The native desktop adapter delivers them only after the user grants OS permission; a browser or remote client can reuse the policy with its own permission and delivery mechanism.
- **Local registry:** saved workspace metadata is atomically written to the app-data directory. Workspace updates preserve the durable workspace ID and existing session records; credentials are deliberately not a registry field.
- **Deep-link recovery:** the desktop adapter refreshes local records before opening a link, attaches only to a matching live session, and provides a recovery-safe message when a workspace or session is unavailable.
- **Remote enrollment seam:** the registry may store scoped, expiring device-grant verifiers—not their one-time secrets. A future companion consumes a verifier exactly once to mint a short-lived attachment token; `@term-dock/broker-client` provides authenticated HTTP/WebSocket adapters without coupling the UI to enrollment storage.

## Known MVP boundaries

The desktop app provides durable process ownership, interactive local and SSH terminal attachment, state observation, opt-in native notifications, and registered `term-dock://` workspace routing. `apps/web` provides a relay-ready browser UI, but the project does not yet provide a remote companion, a public deployment, encrypted relay, cross-device lease management, or terminal multiplexing. These remain explicitly scoped next steps, not hidden assumptions.

## Extension seams

- Add a mutually-authenticated remote companion and WebSocket adapter without changing the broker protocol.
- Add a `SessionStore` abstraction for tmux or remote persistence without changing workspace IDs.
- Add an OS credential-store adapter before SSH credential support.
- Add an opt-in AI provider adapter that accepts only `AiContext`; it should never receive raw terminal transcript by default.
