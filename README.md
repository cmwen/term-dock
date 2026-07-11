# Term Dock

Term Dock is a deep-linkable workspace terminal for developers running multiple local or remote tasks and coding agents.

It turns terminal sessions into durable, addressable workspaces. A workspace can define its directory, startup commands, SSH target, terminal session, and related resources. Users can open a workspace from a dashboard or deep link, see whether its processes need attention, and continue work from another window or device.

## Project status

Early design and research.

## Documents

- [Product requirements](./PRD.md)
- [Technical research](./RESEARCH.md)

## Core idea

```text
term-dock://workspace/<workspace-id>?session=<session-id>
```

A link identifies the workspace and session to open; authorization and session resolution remain local and trusted.

## License

MIT
