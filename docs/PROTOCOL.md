# Session broker protocol

`term-dock.broker/v1` is the transport-neutral contract between a terminal renderer and the local session broker. The desktop webview is the first client. A future browser UI and authenticated remote companion must use the same shapes rather than gaining direct process, filesystem, or Tauri IPC access.

## Messages

| Operation                       | Input                                             | Result                  | Authority boundary                                       |
| ------------------------------- | ------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| Workspace create/update/archive | workspace definition or ID                        | workspace/success/error | Host validates local paths and persists metadata.        |
| Session launch                  | `workspaceId`                                     | `Session`               | Host owns the PTY and process.                           |
| Attach                          | `sessionId`, `access: view/control`               | `SessionAttachment`     | Host decides whether a controller lease is allowed.      |
| Replay                          | `sessionId`, `cursor`                             | `SessionEventReplay`    | Bounded live-host recovery window; re-attach on a gap.   |
| Detach                          | `sessionId`, `attachmentId`                       | success/error           | Releases an active controller lease.                     |
| Input                           | `sessionId`, `attachmentId`, up to 64 KiB         | success/error           | Only a granted controller may write to a PTY.            |
| Resize                          | `sessionId`, `attachmentId`, bounded rows/columns | success/error           | Host applies a single canonical PTY size.                |
| Terminate                       | `sessionId`, `attachmentId`, `confirmed: true`    | success/error           | Explicit confirmation and controller authority required. |
| Event                           | output or state, session ID, cursor               | stream item             | Renderers resume from bounded attachment replay.         |

An attachment contains a bounded UTF-8 output snapshot, a monotonic cursor, and an `outputTruncated` marker. Renderers must not assume a snapshot is the entire session transcript. A granted `control` attachment also receives an opaque `attachmentId`; it is an in-memory capability that must accompany input, resize, terminate, and detach operations. The broker permits only one controller capability per live session. View attachments omit it, and clients must never persist it, put it in a URL, or include it in AI context.

`sessions.replay(sessionId, cursor)` returns ordered events after that cursor from the local host's bounded in-memory recovery window. Its `truncated` flag means a client missed part of the stream and must attach again for a fresh bounded snapshot before rendering further bytes. The replay window is deliberately not persisted; a desktop restart exposes the session as `disconnected` rather than treating prior terminal bytes as durable transcript.

`exited` includes the observed process exit code when available. `disconnected` means the previous host instance no longer owns a live PTY; it is not a claim that the remote process exited cleanly.

## RPC envelope

The web-capable client in `packages/broker-client` uses a versioned JSON envelope. A relay or companion may expose `POST /v1/rpc`:

```json
{
  "protocolVersion": "term-dock.broker/v1",
  "requestId": "req-123",
  "operation": "workspaces.list",
  "payload": {}
}
```

Responses echo `protocolVersion` and `requestId`, and contain either `{ "ok": true, "result": ... }` or `{ "ok": false, "error": { "code": "...", "message": "...", "retryable": false } }`. Clients must reject mismatched protocol versions or request IDs. Access tokens are supplied by the host application at request time, sent only in an `Authorization: Bearer` header, and are never persisted by the client package.

`BrokerClient.subscribeSession(sessionId, cursor, onEvent)` is the streaming seam for terminal output and lifecycle events. A native adapter uses Tauri events today; a remote adapter should bind it to an authenticated WebSocket (or equivalent) and resume from the attachment cursor. Request-only transports explicitly return `stream_unsupported` rather than pretending that a terminal is live.

The shared terminal renderer derives bounded rows/columns from its layout and calls `sessions.resize` only for a `control` attachment. A view-only client never changes canonical PTY dimensions.

The WebSocket adapter opens one authenticated connection per client instance. It sends a short-lived access token in the first `auth` frame—not in the URL—then multiplexes versioned RPC responses and `session-event` frames by request or subscription ID. Reconnects re-authenticate and resubscribe from each subscription's last cursor.

The shared contract exports these relay-safe frame shapes: `auth`, `authenticated`, `error`, `subscribe`, `unsubscribe`, and `session-event`, as well as the existing `BrokerRequest` and `BrokerResponse` envelopes. A companion should validate frames before forwarding them and reject unknown protocol versions, malformed event cursors, invalid session states, or a control request beyond the verified device grant.

`apps/web` is the browser implementation of this client. It holds the access token only in the live connection closure, starts with a `view` attachment, and may request `control`; the companion remains responsible for rejecting a request outside the grant's scope.

## Remote topology

```text
Browser UI -- HTTPS / WebSocket -- authenticated relay -- mutually-authenticated companion -- local broker -- PTY
```

The remote relay is not part of this MVP and no network listener is enabled. When implemented, it must be a transport adapter only:

- device enrollment and short-lived attachment tokens are verified by the companion, not the browser;
- end-to-end encrypted transport protects terminal bytes in transit;
- each request is authorized against a workspace/session and a `view` or `control` lease;
- controller leases are exclusive; secondary clients attach in `view` mode;
- the broker does not accept raw shell commands from links, AI output, or relay metadata;
- terminal output is never included in `AiContext` and must require a separate, visible user export decision.

An SSH-backed workspace is still local-first: the desktop broker starts the local OpenSSH client inside its PTY, and browser or companion clients attach only to that broker session. SSH keys, passwords, jump-host configuration, and forwarding policy do not travel through the broker contract or workspace registry.

## Device grants

The local host can now issue a scoped, revocable device grant. A grant has a device label, an expiry, and either `view` or `control` scope. The displayed `tdg_…` secret is generated with 122 bits of OS randomness and returned exactly once; the local registry persists only its SHA-256 verifier. Listing grants therefore cannot recover an enrollment secret, and revocation removes the verifier immediately.

The future companion must present this secret only over an authenticated enrollment channel, exchange it exactly once for a short-lived attachment token, and never place it in a URL, browser storage, terminal output, or AI context. The local grant is marked consumed at exchange time; later use is rejected even if its expiry has not passed.

The React xterm renderer uses the same workspace, session, attachment, input, and subscription operations as a web client would. Its current Tauri event listener is hidden behind the native transport adapter, not part of the protocol itself.
