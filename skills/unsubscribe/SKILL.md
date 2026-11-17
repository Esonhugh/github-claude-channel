---
description: Unsubscribe one current-session GitHub watch by its server-issued watch ID.
argument-hint: <watch-id>
---

Use the github MCP tool unsubscribe from the github plugin with watch_id=$ARGUMENTS in the CURRENT session. Do not fork/delegate or choose a different consumer. Clarify if the user did not provide exactly one handle. Unknown/already-cancelled handles return already_absent. This removes all targets of only this watch, not another session's subscriptions or shared collectors still in use.

If a host Monitor was used, its stream services all this consumer's watches. Do not stop a shared Monitor merely because one watch was removed. When no watches remain, detach any host Monitor started for this consumer with the host's TaskStop if its actual task ID is known. watch_id is not task_id; never fabricate their mapping. A task being stopped does not itself unsubscribe.
