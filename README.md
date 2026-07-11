# Term Dock

Term Dock is a deep-linkable workspace terminal for developers running multiple local or remote tasks and coding agents.

It turns terminal sessions into durable, addressable workspaces. A workspace can define its directory, startup commands, SSH target, terminal session, and related resources. Users can open a workspace from a dashboard or deep link, see whether its processes need attention, and continue work from another window or device.

## Project status

MVP implemented: a local-first Tauri desktop dashboard with persisted, editable workspace definitions, PTY-backed interactive terminal sessions, activity facts, safe deep-link parsing, and provider-neutral AI context export. Its versioned [session-broker contract](docs/PROTOCOL.md) keeps the future web UI and remote companion transport-independent.

Only one client may hold an in-memory controller attachment for a live terminal. Input, resize, and termination require that opaque capability; closing the terminal releases it. Viewer attachments cannot mutate the PTY.

Live terminal streams carry cursors and have a bounded in-memory recovery window, so a future authenticated relay can resume a brief disconnect or request a fresh broker snapshot when that window has expired.

The desktop host checkpoints its bounded recent-output preview while a PTY is busy and again when the reader closes. This keeps restart recovery useful without persisting an unbounded terminal transcript.

Desktop alerts are opt-in. When enabled, the native app notifies only on an inferred attention transition or an observed exit, with no terminal transcript, command, directory, host, or credential in the notification body.

Opening a workspace resumes an attachable durable session when one exists; a new PTY is launched only when recovery requires it.

An SSH workspace launches the installed local OpenSSH client in that same PTY. Use a host alias or `user@host`; SSH keys, ports, jump hosts, and credential policy remain in your SSH configuration or operating-system keychain and are never saved in the workspace record.

## Run it

Requirements: Node.js 22+, pnpm 11.7+, TypeScript 7.0.2, and Rust 1.85+ (plus the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/)).

```sh
pnpm install
pnpm tauri dev
```

For a browser-only UI preview, run `pnpm dev`. It uses isolated demo data and never launches a shell.

The standalone remote web shell is available with `pnpm dev:web`. It connects only to an authenticated relay/companion endpoint and keeps a short-lived access token in memory for that connection; it never stores the token or puts it in a URL.

## Quality checks

```sh
pnpm lint
pnpm test
pnpm build
cd apps/desktop/src-tauri && cargo test
```

## Repository layout

- `apps/desktop` — the Tauri desktop shell and reusable React/xterm terminal client.
- `apps/web` — a browser-only remote client that uses the shared WebSocket broker transport.
- `packages/broker-contract` — transport-neutral TypeScript types used by the desktop app today and reserved for the browser UI and remote companion.
- `packages/broker-client` — typed HTTP/WebSocket transport adapters and client methods for the desktop, future web UI, and authenticated companion.
- `packages/notification-policy` — privacy-safe session-alert policy shared by native, browser, and future remote clients.
- `packages/terminal-view` — a shared broker-only React/xterm terminal renderer used by both apps.
- `apps/desktop/src-tauri` — the local Rust authority for PTYs, grants, deep links, and persistence.

The Rust host also watches child lifetimes and emits authoritative `exited`/`disconnected` transitions for reconnecting clients.

Every terminal view visibly names its workspace plus local/SSH host and directory, so a remote or local attachment can be verified before input is sent.

The dashboard refreshes local session facts periodically. Idle sessions become `quiet` after a bounded interval; only explicit confirmation prompts are marked as inferred attention.

The root is a pnpm workspace. Run scripts from the repository root so every future app uses the same locked tools and shared contract.

## Documents

- [Product requirements](./PRD.md)
- [Technical research](./RESEARCH.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [AI contract](./docs/AI.md)
- [Session-broker protocol](./docs/PROTOCOL.md)
- [Contributor guide](./AGENTS.md)

## Core idea

```text
term-dock://workspace/<workspace-id>?session=<session-id>
```

A link identifies the workspace and session to open; authorization and session resolution remain local and trusted. An unavailable workspace or non-attachable session produces a safe recovery message rather than a shell action.

## License

MIT
