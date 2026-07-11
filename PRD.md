# Term Dock — Product Requirements

## Summary

Term Dock is a native-first terminal workspace manager. It lets developers define, launch, monitor, deep-link to, and resume terminal-based work without treating a terminal window as the unit of work.

## Problem

Developers increasingly run several long-lived terminal tasks at once: coding agents, builds, development servers, SSH sessions, and operational commands. These tasks are scattered across windows and machines. Ordinary terminals provide weak identity, navigation, status, and hand-off: a user cannot reliably link to a particular workspace, see which session needs attention, or resume it from a dashboard.

Agent-side status reporting is incomplete and costly because it depends on each agent cooperating and may consume model tokens. Term Dock should infer useful state from the terminal and process environment wherever possible.

## Product goal

Make terminal workspaces durable, addressable, observable, and resumable.

A user should be able to select a workspace—or follow a deep link—and arrive at the correct terminal context with minimal latency and no unnecessary exposure of the shell to the network.

## Target user

Developers who routinely manage multiple repositories, coding agents, remote hosts, dev servers, and long-running commands across desktop and mobile devices.

## Core concepts

- **Workspace:** a saved definition containing a local directory or remote target, startup actions, environment references, and related links.
- **Session:** a durable running terminal context associated with a workspace.
- **Terminal view:** a client attached to a session. Multiple views may attach without becoming separate sessions.
- **Activity state:** an inferred state such as running, producing output, quiet, waiting for input, exited, or disconnected.
- **Deep link:** an address that identifies a workspace and optionally a session, view, or action.

## MVP

### Workspace management

- Create, edit, archive, and launch workspace definitions.
- Configure a working directory, shell, startup commands, and optional SSH target.
- Show recent and active workspaces in a fast, searchable dashboard.

### Durable terminal sessions

- Start a PTY-backed session for a workspace.
- Disconnect and reconnect without terminating the underlying task.
- Support multiple terminal views attached to one durable session.
- Preserve scrollback and recent output within explicit limits.

### Deep linking

- Open a workspace by stable identifier.
- Optionally target a particular session.
- Validate every requested target locally; links must not contain credentials.
- Provide a safe fallback when the target no longer exists.

### Lightweight monitoring

- Track process existence, foreground process, exit status, output activity, and last activity time.
- Distinguish known facts from inferred states.
- Notify when a session exits or is likely waiting for user input.
- Allow explicit integrations later, without requiring them for baseline monitoring.

### Safety and trust

- Keep the PTY host local by default.
- Require explicit authorization for remote access and sensitive actions.
- Show exactly which workspace, host, directory, and process a terminal represents.
- Confirm destructive process termination.
- Store secrets in the operating system credential store, not workspace files or links.

## Key user flows

### Launch saved work

1. User opens Term Dock.
2. Dashboard shows workspace health and recent sessions.
3. User selects a workspace.
4. Term Dock opens its existing session or starts the configured launch sequence.

### Resume from a deep link

1. User follows a link from a dashboard, notification, or another tool.
2. The native app resolves and authorizes the workspace identifier.
3. The relevant session opens immediately.
4. If unavailable, the app explains why and offers safe recovery options.

### Respond to a coding agent

1. Term Dock observes that a session has stopped producing output and may be waiting for input.
2. The dashboard changes its attention state and optionally sends a notification.
3. User opens the notification and lands in the exact session.
4. User responds and returns to other work.

## Non-goals for MVP

- Full IDE replacement.
- Cloud-hosted shell service.
- Semantic understanding of every command or agent transcript.
- Multi-user collaboration and shared terminal control.
- General infrastructure observability.
- Automatic execution of commands received from untrusted links.

## Success criteria

- A saved workspace opens or resumes in a few seconds.
- Closing a terminal view does not accidentally terminate the session.
- Deep links consistently resolve to the intended workspace without embedding secrets.
- Users can identify active, exited, and attention-worthy sessions from the dashboard.
- Baseline monitoring works without changes to coding agents or ongoing LLM token usage.

## Open decisions

- Desktop framework and supported operating systems.
- Whether the durable session layer is built in or initially backed by tmux.
- URL scheme versus verified universal/app links.
- Remote companion architecture and mobile interaction model.
- Exact confidence model for detecting input-waiting states.
