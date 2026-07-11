# AI contract

Term Dock is AI-friendly in two directions: it is easy for assistants to work on, and it gives users safe context to use with their chosen assistant.

## Product contract

`get_ai_context` returns a stable JSON payload with the version `term-dock.ai-context/v1`. It includes the workspace identity, local path, shell, SSH alias (if one was explicitly saved), and high-level session facts. User-facing session activity reasons remain presentation metadata and are not copied as terminal transcript.

It never includes:

- terminal output or scrollback;
- environment variables, tokens, credentials, or SSH keys;
- executable commands received from a deep link;
- hidden product telemetry.

The dashboard’s AI action copies this payload locally. It does not call an LLM or send data over the network. Any future model provider must be opt-in, show the exact payload before sending, and use the operating system credential store for its API key.

## Development contract

- Keep user-facing data structures serializable and versioned.
- Put security-sensitive parsing and policy in Rust domain functions with unit tests.
- Prefer explicit tool contracts over prompt-only integrations.
- Never add secrets to fixtures, snapshots, logs, deep links, or workspace files.
- Treat model output as untrusted text; it cannot directly execute a shell command.
- A remote/web adapter must preserve the same data minimisation rules as the native adapter; it does not make terminal output eligible for AI export.
- Device-grant secrets are authentication material, never valid AI context or prompt input.
