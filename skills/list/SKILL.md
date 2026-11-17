---
description: List this session's GitHub watches and collection/delivery health.
---

Call subscriptions on the github MCP server provided by the github plugin in the CURRENT session; do not fork or inspect another consumer. Use pagination (next_cursor) when needed. Group targets by server-issued watch_id. Display target/event scope, subscription_id, collection state, last successful poll, pending deliveries, errors, and delivery mode/status. An empty list means 无订阅.

Distinguish persisted subscription from actual delivery attachment: unknown requires explicit host evidence; unavailable retains events pull; detached Monitor requires an explicit bounded reattachment, not automatic renewal. Never infer Channels enablement from the fact that the MCP connection works, from notification writes or from lack of events/ACK. Use Channels first; Monitor only when Channels is confirmed unavailable and the host genuinely has Monitor. Do not launch tasks just to list watches.
