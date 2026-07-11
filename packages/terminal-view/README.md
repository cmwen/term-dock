# Terminal view

`@term-dock/terminal-view` is the shared React/xterm renderer for native and browser clients. It receives a `BrokerClient`, never imports Tauri or shell APIs, and requests either a `view` or `control` attachment through the broker.

The host decides whether a requested controller attachment is authorized. A control attachment carries an opaque in-memory capability that the renderer sends only with input, resize, and explicit termination, then releases on cleanup. The renderer keeps terminal bytes out of AI context and does not own session lifetime; only the explicitly confirmed broker termination operation can end a session.
