# File Share Bridge API {#file-share-bridge-api}

Short-lived public file shares + private image artifacts. `gateway.publicUrl` supplies a convenience URL; a token can also be used with an integration-owned public base. A token IS the capability — only its SHA-256 hash is
stored, and shares are unenumerable (there is no list endpoint by design).
**The default allowlist is raster images only (PNG / JPEG / WebP);** any other
type is rejected with `415 unsupported_file_type` at both mint and fetch time.
A mint may pass `allow_documents: true` to widen the allowlist to PDF for that
request; the allow-kind is then recorded **per share, narrowed to what the ref
actually validated as** — a PNG in an `allow_documents` batch is still stored as
image-only — and the file is **re-sniffed on every fetch**, so replacing the file
behind a live share never widens what it serves. `agent_id` and `session_id`
must be valid identifiers (same charset as elsewhere) or the request is `400`
before any path resolution.

> **Upgrade / rollback note (#444).** The share table was renamed
> `image_shares` → `file_shares`. Upgrading renames in place, so shares minted
> before the upgrade keep resolving. **Rolling back across #444 does not:** the
> older build recreates an empty `image_shares` and every still-live share URL
> returns `404` until it expires (bounded by the 24 h max TTL — nothing durable
> is lost, since shares are ephemeral by design). Rolling forward again folds
> any rows the older build minted back into `file_shares` and drops the orphan
> table, logging `[share] migrated legacy image_shares:` with the row counts.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/shares` | Key (agent-scoped) | Mint one or more shares for artifact refs / media paths → `{ items: [{ share_id, token, url?, expires_at, task_id?, provider?, prior_prompt? }] }` (order preserved; TTL 10s–24h, default 30 min; idempotent within a 60s window, keyed by allow-kind as well as ref). Optional `allow_documents: true` widens this request's allowlist to PDF; anything non-boolean is `400`. `token` is a host-agnostic capability and is always present; `url` is a convenience built from `gateway.publicUrl` and is omitted when that is unset — callers with their own public base (e.g. LINE) build `<base>/shared/<token>` themselves. `task_id`/`provider`/`prior_prompt` are echoed **only for artifact refs** (never path refs) and only when the artifact's generation recorded them — `task_id`/`provider` are the provider-side handle a resume-capable backend needs (absent when the generating provider has no resume concept), and `prior_prompt` is the prompt that produced the artifact; `generate_image`'s `continue_from` consumes these to resume or hand off an edit session |
| `DELETE` | `/api/v1/shares/:shareId` | Key (owner/admin) | Revoke a share (uniform `404` when the key can't access the owner) |
| `POST` | `/api/v1/image-artifacts` | Key (agent-scoped) | Register generated images as private artifacts (registration never makes a file public) |
| `GET` | `/api/v1/image-catalog?agent_id=&session_id=` | Key (agent-scoped) | Deterministic per-session image list (oldest first); mints nothing, returns no token |
| `GET` | `/api/v1/video-catalog?agent_id=&session_id=` | Key (agent-scoped) | Deterministic per-session video list (oldest first); the video analogue of `/v1/image-catalog`, kept separate so clips never enter the image-reference surface; mints nothing, returns no token |
| `GET`/`HEAD` | `/shared/:token` | None (token IS the capability) | Stream the shared file — images `inline`, documents as an `attachment` whose filename is sanitised (RFC 8187) and whose **extension is forced to match the sniffed type**, not the agent-chosen basename (so `%PDF-` bytes named `invoice.html` download as `invoice.pdf`); always `X-Content-Type-Options: nosniff`; uniform `404` for unknown/expired/revoked/traversal/type-mismatch; per-IP rate limited. This is the single public share primitive — the gateway, MCP subprocesses, and LINE image delivery all mint through `/api/v1/shares` and serve here |

**Renamed in #444** (the bridge is no longer image-only):

| Kind | Was | Now |
|------|-----|-----|
| Error code | `image_ref_not_found` | `share_ref_not_found` |
| Error code | `image_too_large` | `file_too_large` |
| Error code | `unsupported_image_type` | `unsupported_file_type` |
| MCP tool | `share_image` | `share_file` (old name kept as a deprecated alias, still image-only — only `share_file` opts into documents) |
| Env vars | `IMAGE_SHARE_*` | `SHARE_*` (legacy names still read as a fallback) |
| SQLite table | `image_shares` | `file_shares` (renamed in place on first open) |

The error codes are the only breaking part: `code` values in `4xx` bodies changed.
HTTP statuses, request/response shapes and the token format are unchanged.

## Audio playback and fetch aliases

The channel speech pipeline can mint explicitly audio-scoped shares. These serve MP3 as `audio/mpeg` and M4A as `audio/mp4`, inline with `Accept-Ranges: bytes`; a valid single byte range returns `206` and `Content-Range`. The ordinary public mint request above remains image/PDF-only: `allow_documents` does not enable audio.

All fetch paths below accept `GET` and `HEAD`. Other methods return `405` with `Allow: GET, HEAD`. Every alias uses the same token lookup, expiry, containment, size and MIME revalidation; an audio suffix must match the actual file type or the request returns `404`.

| Canonical path | Direct gateway-prefix alias |
| --- | --- |
| `/shared/:token` | `/gateway/shared/:token` |
| `/shared/:token/audio.m4a` | `/gateway/shared/:token/audio.m4a` |
| `/shared/:token/audio.mp3` | `/gateway/shared/:token/audio.mp3` |
