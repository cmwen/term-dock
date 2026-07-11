# Term Dock — Technical Research

## Research question

How can a native-first product make terminal workspaces deep-linkable and observable while retaining terminal compatibility, low latency, and a strong local security boundary?

## Terminal architecture

A terminal UI does not run commands directly. A shell or application runs behind a pseudo-terminal (PTY); the client renders the resulting byte stream and sends keyboard input back. This separation is useful for Term Dock:

```text
shell / agent <-> PTY host <-> session broker <-> native or web terminal view
```

The PTY host owns process lifetime. A terminal view can connect or disconnect without determining whether the process survives.

## xterm.js

xterm.js is a browser terminal emulator, not a shell, PTY, session manager, or security boundary. It is useful when Term Dock needs a web-based terminal surface or a portable renderer inside a desktop webview.

Relevant capabilities include terminal emulation, ANSI styling, selection, search through addons, hyperlink handling, fit/resizing support, Unicode support, and extensibility. The application must still supply transport, authentication, PTY lifecycle, scrollback policy, and session persistence.

For a purely native UI, a native terminal renderer may reduce webview overhead and integrate more naturally with platform input and accessibility. xterm.js remains attractive for fast prototyping and consistent cross-platform behavior.

## tmux as a session layer

tmux already provides durable sessions, windows, panes, detach/reattach, and broad terminal compatibility. Two clients can attach to one tmux session and display different tmux windows. Size behavior needs care: a shared tmux window ultimately has one logical layout, and attached clients with different dimensions can influence the effective size or see unused space. Separate tmux windows are a better fit when clients need independent layouts.

Advantages:

- mature and reliable process persistence;
- immediate compatibility with existing developer workflows;
- reduces MVP implementation risk.

Limitations:

- session identity and metadata must be mapped into Term Dock;
- layout and resize semantics may leak into the product experience;
- control and observation often require parsing tmux state or using its control mode;
- platform availability, especially on Windows, may complicate a native cross-platform product.

A practical approach is to use tmux as an optional early backend behind a session abstraction, rather than exposing tmux as the product model.

## Deep links

A native custom scheme can express targets such as:

```text
term-dock://workspace/<workspace-id>?session=<session-id>
```

The link should contain opaque identifiers and intent, never shell commands, tokens, filesystem secrets, or SSH credentials. The app resolves identifiers against its local registry and applies authorization at open time.

Custom schemes are straightforward but can be claimed by another installed application. Verified HTTPS app links or universal links provide stronger ownership where the platforms and deployment model allow them. An initial custom scheme can be paired with strict validation and explicit confirmation for any action beyond navigation.

## Monitoring terminal activity

No single signal reliably means that a terminal is waiting for the user. Term Dock should combine several low-cost signals and expose confidence rather than claiming certainty.

Useful signals:

- PTY output timestamps and output rate;
- foreground process and process-tree changes;
- process exit status;
- shell prompt integration where available;
- terminal mode changes and cursor behavior;
- known prompts or agent markers;
- CPU utilization and child-process activity;
- optional structured events from tools that support them.

A simple initial state model:

- **Running:** process exists and output or process activity is recent.
- **Quiet:** process exists but no meaningful activity is observed.
- **Needs attention:** heuristics suggest an interactive prompt or a supported integration reports one.
- **Exited:** foreground task or session has ended.
- **Disconnected:** the session host cannot currently be reached.

Start with deterministic facts—running, output activity, exit, disconnect—and label prompt detection as an inference. This avoids depending on agent instructions or paying continuous LLM costs. More advanced local classification can be evaluated later.

## Resizing and multiple clients

A PTY normally has one active row/column size. When multiple clients attach with different dimensions, the session broker needs a policy:

- use the active controller's size;
- use the smallest attached size;
- designate a canonical size;
- create independent views backed by separate terminal contexts.

For MVP, one controlling client per session with read-only secondary views is the simplest predictable behavior. Independent tmux windows or sessions can support truly different layouts.

## Security model

The safest default is a local PTY host and local broker, with the UI connecting over a local IPC mechanism. Remote access should be an explicit additional capability.

Recommended controls:

- OS credential store for secrets;
- authenticated, short-lived session attachment tokens;
- least-privilege local IPC permissions;
- origin and intent validation for deep links;
- no command execution directly from link parameters;
- visible host, directory, and process identity;
- audit events for session creation, attachment, and termination;
- encrypted transport and device authorization for any remote companion.

## Native versus web

A native shell provides reliable deep-link registration, OS credential storage, notifications, local process spawning, lower-friction IPC, and a smaller exposed network surface. A web terminal renderer can still live inside the native application. This hybrid architecture preserves rapid UI development while keeping authority in a native backend.

## Suggested MVP architecture

- Native desktop host owns workspace definitions, PTYs, credentials, and deep-link handling.
- Session broker assigns durable opaque IDs and retains bounded scrollback.
- Terminal UI initially uses xterm.js in a webview or a suitable native renderer.
- Optional tmux adapter provides persistence on Unix-like systems.
- Activity engine consumes PTY and process signals and emits fact-based status plus confidence-scored attention hints.
- Local API uses authenticated IPC; no network listener is enabled by default.

## Experiments to run

1. Prototype one PTY with detach/reconnect and bounded replay.
2. Attach two differently sized clients and test resize policies.
3. Compare xterm.js-in-webview latency and input behavior with a native renderer.
4. Use tmux control mode to map sessions and windows to stable Term Dock IDs.
5. Collect traces from common coding agents and shells to measure prompt-detection precision.
6. Threat-model custom deep links, especially link spoofing and command injection.

## Main conclusion

Term Dock should treat the durable session—not the terminal window—as the core object. A native authority layer can safely resolve deep links and own process lifecycle, while the terminal renderer remains replaceable. Monitoring should begin with cheap, deterministic PTY and process signals and add optional structured integrations instead of relying on LLM-based self-reporting.
