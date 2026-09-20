
## Local safemode controls

Safemode has no public HTTP endpoint. Its local CLI works independently of the
server; allowlisted host operator agents use the scoped `safemode_list`,
`safemode_status`, `safemode_send`, `safemode_logs`, and `safemode_stop` MCP tools.
The private orchestration bridge checks membership, operator configuration and
execution authorization before access. See the [safemode guide](website/guide/safemode.md)
for request IDs, asynchronous receipts, explicit takeover and result retrieval.
