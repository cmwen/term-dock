# Term Dock contributor guide

## Start here

- `PRD.md` defines the product scope.
- `RESEARCH.md` explains the terminal and trust model.
- `docs/ARCHITECTURE.md` records implementation boundaries.
- `docs/AI.md` is the product and engineering AI data contract.

## Workspace layout

- `apps/desktop` owns the native client.
- `apps/web` owns the browser-only remote client; it may only use the shared broker client and terminal-view packages.
- `packages/broker-contract` contains client-neutral TypeScript models only; do not import React, Tauri, Node, or browser globals there.
- `packages/broker-client` contains the transport-neutral client facade plus HTTP/WebSocket adapters; callers provide token retrieval and storage policy.
- `packages/terminal-view` contains the broker-only React/xterm renderer; do not import Tauri or desktop APIs there.
- `apps/desktop/src-tauri` owns local process authority and the Rust implementation.

Use pnpm from the repository root. The workspace pins TypeScript 7 for fast type checking and uses Biome for TypeScript-aware linting without coupling linting to the TypeScript compiler. `pnpm build` and `pnpm test` recurse through every package with a matching script.

## Guardrails

1. The Rust desktop host owns PTYs, processes, filesystem validation, and deep-link parsing.
2. The webview is untrusted presentation code; expose narrow, typed Tauri commands only.
3. Deep links are navigation-only opaque IDs. Do not add command, token, path, or credential parameters.
4. AI context is metadata-only unless the user explicitly previews and authorizes a wider export.
5. Add a test when changing validation, serialization, lifecycle, or security behavior.
6. Keep browser and remote work on `term-dock.broker/v1`; do not expose a PTY, a native IPC handle, or a broad shell API to a web client.
7. Persist only remote-grant verifiers. Enrollment secrets are one-time displays and never belong in logs, links, AI context, or fixtures.
8. Workspace updates change only future launch configuration; they must preserve workspace identity, archive state, and existing session history.

## Checks

```sh
pnpm lint
pnpm test
pnpm build
cd apps/desktop/src-tauri && cargo test
```

Use `pnpm tauri dev` for the desktop app. The browser-only Vite preview uses a clearly isolated demo adapter; it does not spawn processes. `packages/broker-contract` must remain framework- and transport-neutral so the future web UI can import it directly.
