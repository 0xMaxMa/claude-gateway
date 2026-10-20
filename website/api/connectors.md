# Connectors API {#connectors-api}

A **connector** is an MCP server the gateway injects into a Claude Code session's
`mcp-config.json`. The gateway owns three things and nothing else: the connector
definition, the per-connector secret, and the per-agent enablement. At spawn, an
enabled + connected connector is resolved into an `mcpServers` entry. The secret stays
in the gateway: Claude Code reaches the connector through the gateway (see
[Credential isolation](#credential-isolation)).

Every connector lives in `gateway.customConnectors` in `config.json` — admin-trusted
raw `mcpServers` JSON, **not** code-reviewed. Connectors differ along exactly one axis,
`credentialOwner`: who holds the credential and is responsible for keeping it valid.

| `credentialOwner` | Who holds the credential | Written by |
|-------------------|--------------------------|------------|
| `none` | Nobody — `secretNames` is empty, there is nothing to connect or disconnect | `POST /api/v1/connectors/custom` |
| `static` | A human pasted a value; it is valid until someone replaces it | `POST /api/v1/connectors/custom`, `POST /:id/connect` |
| `gateway` | This gateway ran the OAuth flow, holds the `refresh_token`, and renews the `access_token` itself. The only value the refresh sweep acts on | `POST /api/v1/connectors/custom` with `oauth: true` |
| `external` | An external control plane owns the sign-in and pushes fresh tokens in; the gateway never refreshes | `POST /:id/oauth/receive` |

The field is written once, by the route that creates the entry, and read verbatim
everywhere after — nothing re-derives it at read time.

An entry is raw `mcpServers`-entry JSON with `{placeholder}` tokens standing in
for secrets, e.g.:

```json
{
  "type": "streamable-http",
  "url": "https://mcp.example.com/v2/mcp",
  "headers": { "Authorization": "Bearer {api_key}" }
}
```

At add time the gateway extracts every `{name}` placeholder into `secretNames`; at spawn
it substitutes each one from the secret store. A connector counts as **connected** when
every one of its `secretNames` has a value — the secret store alone answers that
question, never `config.json`.

**Secret storage.** Values live in `~/.claude-gateway/mcp-token.env`, a `KEY=value`
file at mode `0600`, parsed fresh on every read (a "connect" takes effect on the next
session spawn, with no gateway restart). Connector keys are namespaced
`CUSTOM__<connectorId>__<placeholderName>` so two connectors that both use `{api_key}`
cannot collide. Override the path with `GATEWAY_MCP_TOKEN_ENV_PATH` (used by tests).

> A reserved second namespace, `CUSTOMINT__<connectorId>__<name>`, holds the gateway's
> own OAuth bookkeeping (refresh token, client id, expiry, failure counters). Placeholder
> names beginning with `__` are rejected at add time, and the two namespaces are separate
> prefixes so a pasted `{__refresh_token}` cannot resolve to gateway-internal state even
> if a future caller forgets to validate.

**Connector ids** are slugs: `^[a-z0-9][a-z0-9-]*$`, max 64 characters. Ids are used
directly as `config.json` object keys and are interpolated into secret-file key names, so
every route validates the shape of `:id` before touching either — anything else is `400
Invalid connector id`, ahead of any lookup.

**Auth levels:** read routes take any valid API key; every mutating route requires an
**admin** key (`admin: true`). The gateway mounts connector management routes only when `gateway.api.keys` is configured.

### Credential isolation {#credential-isolation}

The agent, and every tool or shell command it runs, can read the MCP config files the
gateway writes for it. So for an HTTP connector (`type: "http"` or `"streamable-http"`) whose placeholders sit only in
`url` and `headers`, the file holds a proxy entry instead of the substituted one:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:10850/internal/mcp/connectors/<connectorId>",
  "headers": { "Authorization": "Bearer <per-session grant>" }
}
```

The URL is the address the gateway listens on. The grant is random, held only in
gateway memory, bound to the agent's enabled connectors, and revoked when the
session or worker stops; every spawn, respawn or resume gets a new one. The grant
is the credential: the proxy also refuses non-local connections and requests a
reverse proxy forwarded (`X-Forwarded-For` / `Forwarded`), but treat a grant like
the session's own API key. On every request it resolves the connector again from
`gateway.customConnectors` and `mcp-token.env`, then forwards the MCP request to
the configured `url` with the configured headers. The caller cannot change the
upstream URL or add headers. A redirect to the same origin (a trailing-slash rewrite,
a moved path) is followed with the configured headers, as Claude Code's own transport
did: a `GET`/`DELETE` follows any such redirect, and a `POST` follows a `307`/`308`
with its body (up to 5 hops). A redirect to any other origin is refused with `502`,
so the credential is never sent somewhere the connector config does not name. So a rotated
or refreshed token applies on the next call, and a disconnected connector fails
with `403` even mid-session. A per-agent enablement change still takes effect when
the session restarts, as before. Nothing changes for the operator: no new
configuration, no re-connect.

A stdio or SSE connector, whose secret sits in `env`, `args` or `headers`, gets a
launcher entry instead:

```json
{
  "command": "/path/to/node",
  "args": ["<gateway>/mcp/connector-launcher.mjs"],
  "env": {
    "GATEWAY_CONNECTOR_URL": "http://127.0.0.1:10850/internal/mcp/connectors/<connectorId>/stdio",
    "GATEWAY_CONNECTOR_GRANT": "<per-session grant>"
  }
}
```

Claude Code starts the launcher as the connector's stdio server. The launcher
upgrades a connection to the gateway with the grant and sends the working directory
and environment Claude Code gave it. The gateway resolves the connector again and
spawns `mcp/connector-bridge.ts`, writing the resolved entry to its stdin. For a stdio
entry, the bridge starts the server with the launcher's environment plus the entry's
`env`, in the launcher's working directory, the same way Claude Code starts it, and
passes the MCP stream through byte for byte. For an SSE entry, it forwards each
JSON-RPC message to the configured `url` with the configured headers, under the same
redirect policy as the HTTP proxy: same-origin redirects are followed, a redirect to
another origin fails the request. The same grant rules apply. A revoked grant stops running bridges, and a disconnected or disabled
connector fails on its next launch.

The launched server's stderr, and the bridge's own errors, go to the gateway log as
they arrive, one line per entry prefixed `connector-proxy: agent=<agentId>
connector=<connectorId> stderr:` (capped at 256 KiB per launch). Before, Claude Code
kept a stdio server's stderr in its own per-server MCP log; that log no longer
receives it.

A placeholder in any other field of the entry is resolved in the gateway too. That
field is left out of the file, because no transport the gateway drives reads it.
For example, an `env` block on an HTTP entry.

**Legacy app-agent containers.** An app-agent's own Claude Code session runs inside
its container, where the gateway's loopback address is unreachable. Every connector
of that session, HTTP included, gets a launcher entry that connects through a unix
socket the gateway binds in the bind-mounted workspace
(`/workspace/.gateway-connectors/<random>.sock`, mode `0600`). The bridge runs inside
the same container with `docker exec`, so stdio servers and upstream URLs see the
container's filesystem and network as before. Its code is sent over the same pipe as
the resolved entry, so no file the agent can edit receives the secret. The directory
holds a `.gitignore` of `*`, so an agent workspace that is a git repository never
tracks it, and sockets a crashed gateway left behind are removed when the next session
prepares it.

This needs Node in the container. The gateway checks for it when the session spawns.
A container without Node keeps the substituted entries it had before, and so does a
workspace whose socket path exceeds the 107-byte unix socket limit. The gateway logs a
warning and reports those connectors with `secretExposure: "agent-readable"` and
`exposedAgents` naming the agent, until that agent's next spawn reaches the gateway.

**Still written to the file.** Three cases keep the direct path they had before, are
still written resolved, and are reported with `secretExposure: "agent-readable"`:

- an entry with a `headersHelper`, a command that only Claude Code runs and whose
  headers it adds to each request;
- an entry with an `oauth` block, which starts Claude Code's own sign-in against the
  entry's `url`;
- a `ws` transport, which the gateway cannot carry.

The first two apply whether or not the field holds a placeholder: behind the proxy
the helper's headers would be dropped, and sign-in would target the proxy URL.

**Residual exposure.** A stdio server runs as the agent's OS user and reads its secret
from its own environment or command line. A process of that user can read
`/proc/<pid>/environ`, and any local user can read `/proc/<pid>/cmdline`. That was
true before this change, and it stays true. The change removes the copy in the config
file: the secret is no longer in any file the agent can read, list or upload. The SSE
bridge receives its headers over a pipe, so they are not in any process's
environment or arguments.

---

## GET /api/v1/connectors {#get-apiv1connectors}

List every connector with its current connected state.

```bash
curl -s -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/connectors | jq
```

```json
{
  "connectors": [
    {
      "id": "firecrawl",
      "label": "Firecrawl",
      "description": "Web scraping and crawling",
      "credentialOwner": "gateway",
      "connected": true,
      "repoUrl": "https://firecrawl.dev",
      "refresh": {
        "consecutiveFailures": 3,
        "permanentFailures": 0,
        "nextAttemptAt": 1893456000000
      }
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `credentialOwner` | `none` \| `static` \| `gateway` \| `external` — see the table above. Also tells a UI which way to offer connecting: a paste-token box (`static`), a "Sign in" link pointing at `/oauth/start` (`gateway`), or neither |
| `connected` | Every required secret is present (always `true` for `credentialOwner: "none"`) |
| `defaultEnabled` | Present when the entry stores one. `false` means an agent gets the connector only with its own `{"enabled": true}` |
| `paused` | Present and `true` only while the connector is paused (see [`PATCH /:id`](#patch-apiv1connectorsid)). A paused connector still reports `connected: true` |
| `secretExposure` | `"agent-readable"` when the connector's secret is still written into a session's MCP config file: for every agent when the entry has a `headersHelper` or `oauth` field or a `ws` transport, or for the agents in `exposedAgents` (see [Credential isolation](#credential-isolation)). Absent when the secret stays in the gateway. Also returned by `GET /api/v1/connectors/:id/status` |
| `exposedAgents` | With `secretExposure`, when only some agents' sessions write the secret: agents whose latest spawn could not use the gateway route (an app-agent container without Node, or a socket path too long to bind). Sorted agent ids; in memory, so empty again after a gateway restart until those agents spawn |
| `refresh` | **Absent when healthy.** Present only while a `gateway`-owned connector's background token refresh is failing — either transiently (a network error, DNS, a 5xx) or because the authorization server itself refused the grant. See below. Never present for any other owner: this gateway holds a `refresh_token` for none of them. |

`connected` is computed purely from secret presence, and a transient refresh
failure deliberately never deletes the stored token (an outage must not destroy a
valid sign-in). So a connector whose provider disappeared hours ago still reports
`connected: true` while every call through its expired token fails. `refresh` is
what lets a UI say "connected, but refreshing is failing" instead of showing an
indefinite green checkmark:

| Field | Description |
|-------|-------------|
| `refresh.consecutiveFailures` | Transient failures in a row; resets to `0` on the first success, and on any answer from the authorization server (including a refusal — that proves the host is reachable) |
| `refresh.permanentFailures` | Refusals from the authorization server in a row (`invalid_grant` and friends). At `3` the sweep gives up and deletes the connector's credentials, so `2` means one tick away from being disconnected — the most actionable value this block can carry. Resets to `0` on the first success. |
| `refresh.nextAttemptAt` | Epoch ms. The sweep skips this connector until then |
| `refresh.unrefreshable` | Present and `true` only when this connector can never refresh: it has an access_token, no refresh_token was ever stored, and the token is either expired or has no recorded expiry at all. Both counters read `0` — nothing failed, there is simply nothing to refresh with. Reconnecting is the only fix. |

The two counters are mutually exclusive: a refusal ends the transient streak and a
network failure ends the permanent one, so exactly one of them is non-zero at a
time. The block is present whenever either is — or when `unrefreshable` is set,
which is the one case where both counters are `0`.

`unrefreshable` is reachable through ordinary configuration, not just a hand-edited
file: an authorization server that advertises scopes not including `offline_access`
issues a token response with no refresh_token at all. The sweep then skips that
connector on every tick, silently and forever, and without this flag `connected`
would stay `true` over a token that expired an hour in.

The missing-expiry case covers tokens this gateway never minted — every path that
stores one records an expiry beside it, defaulting to an hour when the server omits
`expires_in`. An `oauth: true` connector holding a pasted `access_token` is the way
to get there; `POST /api/v1/connectors/custom` now rejects that combination, so this
reports the rows that predate the check.

The retry interval doubles with each consecutive transient failure — 5m, 10m, 20m,
… capped at 6 hours — so a permanently dead MCP URL costs a handful of attempts a
day rather than one every five minutes forever, and still recovers on its own the
moment the provider answers again. There is no give-up state for transient
failures: only the authorization server explicitly declaring the grant dead
(`invalid_grant` and friends, three times running) clears the credentials.

**Errors.** This route answers `500 {"error": "Connector configuration could not be
read"}` if the connector list cannot be assembled at all; the reason is logged, not
returned. A single unreadable *entry* degrades to one row with `connected: false`
instead, and the rest of the list is still returned. If the secret store itself
(`mcp-token.env`) cannot be read, every connector reports `connected: false` — the
honest answer while the file is unreadable — and the failure is logged at most once
a minute rather than once per poll.

---

## GET /api/v1/connectors/:id/status {#get-apiv1connectorsidstatus}

Connected state for one connector — cheap enough to poll while an OAuth sign-in
completes in another tab.

```json
{ "id": "firecrawl", "connected": true }
```

A `gateway`-owned connector whose background refresh is currently failing also carries the
same `refresh` block documented under `GET /api/v1/connectors` above:

```json
{
  "id": "firecrawl",
  "connected": true,
  "refresh": { "consecutiveFailures": 3, "permanentFailures": 0, "nextAttemptAt": 1893456000000 }
}
```

It also carries `defaultEnabled` when the entry stores one, and `paused: true` while
the connector is paused.

`404` when the id is not a configured connector.

---

## POST /api/v1/connectors/:id/connect {#post-apiv1connectorsidconnect}

Store a pasted token into a connector that declares exactly one secret. **Admin.**
This is what lets a paste-token connector be reconnected after `DELETE`
soft-disconnected it, without retyping its config.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | The secret. Trimmed; must be non-empty |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{"token": "<paste-token-here>"}' \
  http://localhost:10850/api/v1/connectors/stripe/connect | jq
```

```json
{ "id": "stripe", "connected": true }
```

| Status | When |
|--------|------|
| `400` | Missing/blank `token`; `credentialOwner: "gateway"` (use `/oauth/start`); `credentialOwner: "external"` (use `/oauth/receive`); or it needs more than one secret (remove and re-add it via `POST /api/v1/connectors/custom`) |
| `404` | Unknown id |

Sessions already running for an agent that uses this connector are restarted (idle
channel sessions on their next message, busy ones after the current turn) so the new
secret actually reaches them — an MCP subprocess reads its config once, at spawn.

---

## POST /api/v1/connectors/:id/oauth/receive {#post-apiv1connectorsidoauthreceive}

Accept a fresh `access_token` **plus the full connector shape** pushed in by an external
control plane. **Admin.**

This exists because an externally-owned connector never runs its token exchange here. The
gateway runs inside the user's own VM, reachable from that user's own shell — a shared
`client_secret` cannot live here safely. So a control plane the deployer runs owns the
client secret, the exchange and the refresh loop, and pushes the resulting short-lived
token to this route over the internal network, authenticated with an admin API key like
any other admin caller.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `access_token` | string | Required, non-empty |
| `label` | string | Required, non-empty |
| `config` | object | Required. Must contain **exactly one** `{access_token}` placeholder and no others |
| `description` | string | Optional |
| `sourceUrl` | string | Optional |

`secretNames` is never read from the request body — it is derived from `config` and
required to be exactly `["access_token"]`.

A push onto an existing id keeps that entry's `paused` and `defaultEnabled`, so a control
plane that re-pushes on every token refresh does not resume a paused connector or undo
its agent scope. Set both through [`PATCH /:id`](#patch-apiv1connectorsid).

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{
        "access_token": "<token>",
        "label": "Gmail",
        "config": {
          "type": "streamable-http",
          "url": "https://mcp.example.com/gmail",
          "headers": { "Authorization": "Bearer {access_token}" }
        }
      }' \
  http://localhost:10850/api/v1/connectors/gmail/oauth/receive | jq
```

```json
{ "id": "gmail", "connected": true }
```

The entry is written to `gateway.customConnectors` with `credentialOwner: "external"`,
and every session already using this connector is restarted so the
next spawn picks up the fresh token.

**`400` on a reserved id.** This is the only route that takes a connector id
verbatim instead of minting it through the slugifier, so it is the only one that
can name a server the gateway writes into every session's `mcp-config.json`
itself. `gateway` and `telegram` are therefore rejected:

```json
{ "error": "Connector id 'gateway' is reserved by the gateway's own MCP servers" }
```

Without this the push would succeed, store its token, and report `connected: true`
on every status surface — while the session writer silently dropped the colliding
entry, so the connector never reached a single session and could not be fixed
except by deleting it.

---

## DELETE /api/v1/connectors/:id {#delete-apiv1connectorsid}

Disconnect. **Admin.** Admin is checked *before* the id is looked up, so a non-admin
caller cannot use this route to learn which ids exist.

What it removes depends on the entry:

| `credentialOwner` | Effect |
|-------------------|--------|
| `static` | Clears the secrets only — the entry (label, config, `sourceUrl`) survives so it can be reconnected without retyping. The definition exists nowhere else |
| `gateway` | Clears the OAuth `access_token` only (plus the internal bookkeeping below); the entry survives, and so does any *other* `{placeholder}` value that was pasted when the connector was added. Only `access_token` is the gateway's to re-mint at sign-in — a `{workspace_id}` alongside it can be re-supplied by no route at all (`/connect` is closed to `gateway` owners), so clearing it would make one Disconnect permanent |
| `none` | Removes the entry. There is no secret to clear, so a soft disconnect would leave the row reporting "connected" forever |
| `external` | Removes the entry — its definition lives in the control plane, and reconnecting re-pushes a full entry via `/oauth/receive` |

For a `gateway`-owned entry the gateway also clears its refresh token, client id, expiry,
failure counters, token generation and cached dynamic-client registration. Those are
internal bookkeeping and are not in `secretNames`; left behind, the still-valid refresh
token would let the background sweep silently mint a new access token and resurrect the
connector the user just disconnected, and a stale cached registration would make the
next `/oauth/start` reuse a `client_id` the provider may no longer recognise.

Sessions already using the connector are restarted so they stop offering a tool whose
credential is gone. Which sessions those are is decided by comparing each running
session's spawn-time connector fingerprint against what the connector resolves to *now* —
so a cleared secret, an edited config, or a removed entry all count, and a session
spawned before the connector existed is left alone. When the whole entry is removed, the
connector's per-agent enablement flags in `config.json` are removed with it, so a later
connector that slugs to the same id does not inherit them.

```json
{ "id": "firecrawl", "connected": false }
```

DELETE is the only destructive route. To switch a connector off for a while and keep
its credential, pause it instead.

---

## PATCH /api/v1/connectors/:id {#patch-apiv1connectorsid}

Pause or resume a connector, or change its `defaultEnabled`. **Admin.** Check for
`capabilities.connectorPause: true` in `GET /api/v1/connectors` first.

| Field | Type | Description |
|-------|------|-------------|
| `paused` | boolean | `true` removes the connector from every agent, whatever its per-agent flag says. `false` resumes it |
| `defaultEnabled` | boolean | Whether an agent with no flag of its own gets the connector. `true` does not override `gateway.connectorsDefaultEnabled: false` |

Send at least one field. This route never touches `mcp-token.env`: a paused connector
keeps its secret and stays `connected: true`, and resuming needs no re-entry. Sessions
that use the connector are restarted in the same way as for DELETE, so they lose (or get
back) its tools.

```bash
curl -X PATCH -H "X-Api-Key: admin-key-456" -H "Content-Type: application/json" \
  -d '{"paused": true}' http://localhost:10850/api/v1/connectors/ops-api | jq
```

```json
{ "id": "ops-api", "paused": true, "defaultEnabled": false }
```

`400` for a non-boolean field or an empty body, `404` for an unknown id.

---

## GET /api/v1/connectors/:id/agents {#get-apiv1connectorsidagents}

Which agents the connector reaches. **Admin**, because the answer lists every agent
on the gateway. Check for `capabilities.connectorScope: true` first.

The answer is computed from the per-agent `connectors` maps with the same rule the
session spawner uses, so it always matches what is injected. Nothing about scope is
stored on the connector.

```json
{
  "id": "ops-api",
  "mode": "selected",
  "defaultEnabled": false,
  "paused": false,
  "agents": [
    { "id": "alfred", "enabled": true },
    { "id": "jarvis", "enabled": false }
  ]
}
```

| Field | Description |
|-------|-------------|
| `mode` | `all` when every agent gets the connector and the connector does not opt out by itself (`defaultEnabled: false`). Otherwise `selected` |
| `defaultEnabled` | Whether an agent without its own flag (a new agent, for example) gets it. On a gateway with `connectorsDefaultEnabled: false` this is `false` even in `all` mode |
| `paused` | Pausing does not change `agents`. It only stops the connector from resolving |
| `agents[].enabled` | Whether this agent gets the connector when it is not paused |

A toggle sent through `PATCH /api/v1/agents/:id` shows up here with no other call.

---

## PUT /api/v1/connectors/:id/agents {#put-apiv1connectorsidagents}

Set which agents get the connector, in one `config.json` write. **Admin.**

| Body | Effect |
|------|--------|
| `{"mode": "all"}` | Sets the connector's `defaultEnabled: true` and removes every agent's flag for it. On a gateway with `connectorsDefaultEnabled: false`, each current agent gets `{"enabled": true}` instead, because the default alone reaches no agent there |
| `{"mode": "selected", "agents": ["alfred"]}` | Sets `defaultEnabled: false`, gives the listed agents `{"enabled": true}` and removes the flag from every other agent |

Flags for other connectors are left alone. Only the agents whose answer changed have
their sessions restarted. Answers with the same body as the GET.

`400` for an unknown `mode`, a missing or non-string `agents` list in `selected` mode,
`agents` in `all` mode, or an agent id that is not configured (nothing is written).
`404` for an unknown connector.

---

## POST /api/v1/connectors/custom {#post-apiv1connectorscustom}

Add a user-pasted connector. **Admin.**

Before relying on per-connector opt-in, clients should check that
`GET /api/v1/connectors` returns `capabilities.perConnectorDefaults: true`.
Older gateways may ignore unknown fields.

When the request does not specify a scope, the new connector reaches every agent, as
it always has. Restrict it only when you mean to: send `defaultEnabled: false` here, or
scope it afterwards through [`PUT /:id/agents`](#put-apiv1connectorsidagents) or
[`PATCH /:id`](#patch-apiv1connectorsid).

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `label` | string | Required, non-empty. The id is slugified from it (`"Google Calendar!"` → `google-calendar`), with `-2`, `-3`, … appended on collision |
| `config` | object | Required. Raw `mcpServers` entry with `{placeholder}` tokens |
| `secrets` | object | Optional `{ "<placeholderName>": "<value>" }`. All values must be strings; blank ones are skipped, leaving the connector "not connected" until filled in later via `/connect` |
| `description` | string | Optional |
| `sourceUrl` | string | Optional — where the admin says the config came from. Unverified |
| `defaultEnabled` | boolean | Optional. `false` restricts the connector to agents with their own `{"enabled": true}`. Omitted, it reaches every agent (subject to `gateway.connectorsDefaultEnabled`). Returned in the response when sent |
| `oauth` | boolean | Optional. Asks the gateway to run the sign-in itself — stores `credentialOwner: "gateway"`. Requires `config.url` and an `{access_token}` placeholder, and refuses an `access_token` in `secrets` (the gateway mints that one at `/oauth/start`). Without it the entry is `static` (it declares `{placeholder}`s) or `none` (it declares none) |

```bash
curl -X POST \
  -H "X-Api-Key: admin-key-456" \
  -H "Content-Type: application/json" \
  -d '{
        "label": "Firecrawl",
        "oauth": true,
        "config": {
          "type": "streamable-http",
          "url": "https://mcp.firecrawl.dev/v2/mcp-oauth",
          "headers": { "Authorization": "Bearer {access_token}" }
        }
      }' \
  http://localhost:10850/api/v1/connectors/custom | jq
```

```json
{ "id": "firecrawl", "label": "Firecrawl", "connected": false }
```

| Status | When |
|--------|------|
| `400` | `label`/`config` missing or the wrong type; `secrets` not an object of strings; **a `secrets` key that is not a `{placeholder}` in `config`** (nothing would ever read it back, so it is reported instead of silently stored); `oauth` not a boolean; `oauth: true` without `config.url` or without an `{access_token}` placeholder; **`oauth: true` with an `access_token` in `secrets`** (see below); **or a placeholder name starting with `__`, which the gateway reserves for itself** |

The id is chosen inside the config write lock, so two concurrent adds of the same label
get distinct ids rather than the second overwriting the first. If every secret is present
the connector is immediately connected, and sessions that resolve it are restarted.

**`oauth: true` will not take a pasted `access_token`.** That combination asks for a
`gateway`-owned entry — one the refresh sweep renews from the `refresh_token` the
sign-in stores — and a pasted token arrives without one, because the gateway never saw
the exchange it came out of. It would read `connected: true` and then simply stop
working when it aged out, with nothing to renew it and no failure recorded (the sweep
skips a connector it cannot refresh). Sign in via `/oauth/start`, or omit `oauth` to
store the token as a `static` connector, which is what a hand-held token is. The
connector's *other* placeholders are unaffected — a `{workspace_id}` on an OAuth
connector is configuration the sign-in neither writes nor can supply.

Removal is the unified `DELETE /api/v1/connectors/:id` above — there is no separate
`/custom/:id` delete route.

---

## POST /api/v1/connectors/custom/:id/oauth/start {#post-apiv1connectorscustomidoauthstart}

Begin OAuth sign-in for a `gateway`-owned connector (added with `oauth: true`). **Admin.**

Unlike `/oauth/receive`, the whole dance runs **here**, inside the user's own VM — RFC
8414 metadata discovery, RFC 7591 dynamic client registration, PKCE (S256), the code
exchange and the refresh loop. No external service ever sees the resulting token.

Requires [`gateway.publicUrl`](/reference/configuration) to be set: the provider needs
a reachable HTTPS callback, which is `<publicUrl>/oauth/mcp/callback`.

```bash
curl -X POST -H "X-Api-Key: admin-key-456" \
  http://localhost:10850/api/v1/connectors/custom/firecrawl/oauth/start | jq
```

```json
{ "authorizeUrl": "https://as.example.com/authorize?response_type=code&client_id=..." }
```

Open `authorizeUrl` in the end user's browser. A `client_id` registered by a previous
attempt is reused rather than orphaning a new one at the provider on every click — but
only while the `redirect_uri` it was registered against still matches, so changing
`gateway.publicUrl` correctly forces re-registration.

The gateway registers a client dynamically (RFC 7591) whenever the provider advertises a
`registration_endpoint`. For a provider that advertises none, set a pre-registered
`client_id` in the `MCP_OAUTH_CLIENT_ID__<CONNECTOR_ID>` environment variable (id
upper-cased, every non-alphanumeric run replaced with `_` — connector `google-calendar`
reads `MCP_OAUTH_CLIENT_ID__GOOGLE_CALENDAR`). Without either, `/oauth/start` returns
`502` naming the env var it looked for.

The `scope` requested is the MCP server's own `scopes_supported` (RFC 9728
protected-resource metadata) when it publishes one, falling back to the authorization
server's list (RFC 8414) and then to `offline_access`. The resource's list comes first
deliberately: the AS's is every scope it issues for every resource behind it, so
consenting to it would grant this gateway a whole provider's privileges — and on an AS
whose catalogue includes scopes this client is not entitled to, it is an
`invalid_scope` refusal that kills the sign-in. Set
`MCP_OAUTH_SCOPES__<CONNECTOR_ID>` (space-separated, same id transform as
`MCP_OAUTH_CLIENT_ID__`) to override both — that is the way out of an `invalid_scope`,
or of a provider that only issues a refresh token when `offline_access` is asked for
and never advertises it, without patching the gateway.

| Status | When |
|--------|------|
| `400` | The connector is not `credentialOwner: "gateway"` (an `external` one is told to use `/oauth/receive` instead), or its `config.url` is missing |
| `404` | Unknown id |
| `500` | No valid `gateway.publicUrl` configured |
| `502` | Discovery or client registration failed upstream |

---

## GET /oauth/mcp/callback {#get-oauthmcpcallback}

The provider's redirect target. **Public — no API key**, because the end user's browser
has none to present. Its security rests on the `state` value: single-use, TTL'd and
unguessable, the same posture the CLI pairing routes already use.

Registered at **both** `/oauth/mcp/callback` and `/gateway/oauth/mcp/callback`. The
`redirect_uri` sent to the provider is `<publicUrl>/oauth/mcp/callback`, and
`publicUrl` always ends in `/gateway` — so behind the usual reverse proxy, which
strips that prefix, the request arrives at the bare path, while a gateway reached
directly on its own port receives the prefixed one. Both are the same handler; a
flow started against one and returning to the other completes normally.

Query params are the standard `code` / `state` / `error`. On success the gateway
exchanges the code, stores the access token (plus refresh token and expiry, internally)
in a single write, and restarts sessions that use the connector so the sign-in reaches
the agent the user is actually talking to — without that, status would report
"connected" while a running session still had no such tool. A restart failure is logged,
not surfaced: the token is stored either way.

The connector is re-read before the exchange and again immediately before the write. If
it was deleted, or handed to another owner via
[`/oauth/receive`](/api/connectors#post-apiv1connectorsidoauthreceive), while the user sat on the
provider's consent screen, the token is discarded and the callback answers
`connector_gone` — nothing is stored. Without that re-check a returning callback could
resurrect a connector the admin had just disconnected, or leave internal refresh state
behind on an entry the gateway no longer owns, which nothing would ever collect.

Where the browser lands depends on
[`gateway.oauthReturnUrl`](/reference/configuration):

| `oauthReturnUrl` | Success | Failure |
|------------------|---------|---------|
| Set | `302` to that URL | `302` to that URL with `?connector_oauth_error=<code>` |
| Unset | A plain "Connected — you can close this tab" page | A plain error page (`400`/`409`/`502`) |

"Set" means set to a well-formed `http(s)` URL — anything else (including a
`javascript:` or `data:` URL, which `new URL()` parses happily) is logged at startup and
treated as unset, so it can never become the `Location` of a redirect on this public
route.

Error codes are `expired_link` (unknown, expired or already-used `state`),
`missing_code`, `connector_gone`, `exchange_failed`, or the provider's own `error` value
passed through.

There is deliberately no interstitial "Connected!" page with a timed meta-refresh — when
the deployer has told the gateway where "back" is, a real redirect goes straight there.

---

## Token refresh {#token-refresh}

For `oauth: true` connectors the gateway refreshes tokens itself, on the same 60-second
interval that prunes pairing state. A connector is refreshed when its recorded expiry is
within 5 minutes.

- Failures back off for 5 minutes rather than retrying every tick.
- After **3** consecutive failures **that the authorization server itself declared**
  (`invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_scope`) the gateway
  gives up and clears the connector's tokens, so its status honestly flips to "not
  connected" instead of showing a green checkmark backed by a token that will never
  refresh again. Anything else — DNS, a timeout, a `502`, a discovery step that returned
  the wrong shape — only backs off and never counts toward that limit: giving up deletes
  the user's credentials, and a provider being unreachable says nothing about whether the
  grant is still valid.
- Discovery metadata is cached for 6 hours on this path (an admin-initiated
  `/oauth/start` always re-discovers).
- A tick is skipped while the previous sweep is still in flight. Two concurrent sweeps
  would POST the same refresh token twice, and a provider that rotates refresh tokens
  (the default for a public OAuth 2.1 client) treats the second use as replay and revokes
  the whole grant.
- If a manual reconnect lands while a refresh is in flight, the newer token wins — the
  slower, now-stale refresh result is discarded rather than clobbering it.
- A successful refresh restarts sessions using that connector, for the same reason
  `/oauth/receive` does.

---


## Connector resources {#connector-resources}

Admin-created HTTP connectors may set `resourcesPath` (a simple same-origin path such as `/v1/grants`). `GET /api/v1/connectors/:id/resources` lists those resources; `DELETE /api/v1/connectors/:id/resources/:resourceId` revokes one. Both require connector-admin access, use stored credentials without exposing them to the caller, reject redirects, and have a 10-second network timeout. The list endpoint advertises `capabilities.connectorResources`. `DELETE /api/v1/connectors/:id?remove=true` explicitly removes the connector definition and its agent flags as well as credentials; ordinary DELETE retains its existing behavior. Revoke remote resources before removing their local credentials.

For existing HTTP connectors, admins can PATCH `/api/v1/connectors/:id/management` with `{ "resourcesPath": "/v1/grants" }` without replacing credentials. Model provider capacity/unavailability is reported as HTTP 503 by the message API and with an actionable provider message in chat.
