# Notification policy

`@term-dock/notification-policy` maps broker `attention` and `exited` state events into small, platform-neutral notification candidates. It intentionally omits terminal output, commands, directories, hosts, credentials, and AI context.

Native, browser, and remote clients decide whether to request permission and how to deliver a candidate. The policy itself performs no I/O and has no platform dependency.
