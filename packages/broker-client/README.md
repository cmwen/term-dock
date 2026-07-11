# Broker client

Transport adapters for `@term-dock/broker-contract`. The package is usable by the future web UI without importing Tauri or a desktop-only API.

`createHttpBrokerTransport` accepts an access-token provider instead of persisting credentials. A relay can therefore rotate short-lived tokens without teaching the UI about grant secrets or device enrollment. It posts the versioned envelope to `/v1/rpc`, validates the response protocol and request ID, and never puts the token in a URL or browser storage.

The client also exposes `subscribeSession`, which is implemented by streaming-capable transports. The HTTP adapter is intentionally request-only and reports `stream_unsupported`; a future companion can provide the same client facade over an authenticated WebSocket.

`createWebSocketBrokerTransport` is the browser-ready implementation. It authenticates with a short-lived token in the first WebSocket frame, multiplexes RPC calls and session events, resumes subscriptions from their latest cursor after reconnect, and never embeds credentials in the endpoint URL.
