# File Share Bridge API {#file-share-bridge-api}

Short-lived public file shares + private image artifacts. `gateway.publicUrl` supplies a convenience URL; a token can also be used with an integration-owned public base. A token IS the capability — only its SHA-256 hash is stored, and shares are unenumerable (there is no list endpoint by design).

Ordinary share API requests remain image-only (PNG / JPEG / WebP); `allow_documents: true` opts that request into PDF. The explicit MCP `share_file` tool also sets `allow_all_files: true`, which allows arbitrary existing files under the agent media root or non-isolated agent workspace. Isolated agents remain limited to the current session's media directories. All paths are canonicalized, symlink escapes and non-regular files are rejected, and only a root kind plus a relative path is stored. The share is revalidated on every fetch. Images remain inline; other files are attachments, with `application/octet-stream` for unrecognized and active content and `X-Content-Type-Options: nosniff`. File mode has no fixed per-file or aggregate size cap; large responses stream from disk and support single byte ranges. No file bytes are uploaded while minting a URL. `agent_id` and `session_id` must be valid identifiers (same charset as elsewhere) or the request is `400` before path resolution.

Worker `share_file` first checks task path authorization and source readability. Existing session media paths are reused; workspace files are hard-linked into the session media directory when permitted, or stream-copied across filesystems and when protected hard-link rules deny the link. Preparation uses bounded memory and does not apply the direct-attachment 50 MiB cap. The private API and download route retain their root containment, type, expiry and token checks. Direct attachments and image registration retain their existing limits.

A mint may pass `allow_documents: true` to widen the allowlist to PDF for that request; the allow-kind is recorded per share, narrowed to what the ref validated as, and re-sniffed on every fetch. Replacing a file behind an existing image/PDF share therefore does not widen what it serves.

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
| `POST` | `/api/v1/shares` | Key (agent-scoped) | Mint one or more shares for artifact refs / paths → `{ items: [{ share_id, token, url?, expires_at, task_id?, provider?, prior_prompt? }] }` (order preserved; TTL 10s–24h, default 30 min; idempotent within a 60s window, keyed by allow-kind as well as ref). Optional `allow_documents: true` widens this request's allowlist to PDF; `allow_all_files: true` opts into arbitrary files under authorized roots; either field must be boolean. `token` is a host-agnostic capability and is always present; `url` is a convenience built from `gateway.publicUrl` and is omitted when that is unset — callers with their own public base (e.g. LINE) build `<base>/shared/<token>` themselves. `task_id`/`provider`/`prior_prompt` are echoed **only for artifact refs** (never path refs) and only when the artifact's generation recorded them — `task_id`/`provider` are the provider-side handle a resume-capable backend needs (absent when the generating provider has no resume concept), and `prior_prompt` is the prompt that produced the artifact; `generate_image`'s `continue_from` consumes these to resume or hand off an edit session |
| `DELETE` | `/api/v1/shares/:shareId` | Key (owner/admin) | Revoke a share (uniform `404` when the key can't access the owner) |
| `POST` | `/api/v1/image-artifacts` | Key (agent-scoped) | Register generated images as private artifacts (registration never makes a file public) |
| `GET` | `/api/v1/image-catalog?agent_id=&session_id=` | Key (agent-scoped) | Deterministic per-session image list (oldest first); mints nothing, returns no token |
| `GET` | `/api/v1/video-catalog?agent_id=&session_id=` | Key (agent-scoped) | Deterministic per-session video list (oldest first); the video analogue of `/v1/image-catalog`, kept separate so clips never enter the image-reference surface; mints nothing, returns no token |
| `GET`/`HEAD` | `/shared/:token` | None (token IS the capability) | Stream the shared file — images `inline`, documents and arbitrary files as sanitized `attachment`s; known types use a type-derived extension and opaque files retain only a passive extension from the safe set. Unknown/active types use `application/octet-stream`; always `X-Content-Type-Options: nosniff`. File-mode shares support one byte range. Uniform `404` for unknown/expired/revoked/traversal/type-mismatch; per-IP rate limited. This is the single public share primitive — the gateway, MCP subprocesses, and LINE image delivery all mint through `/api/v1/shares` and serve here |

**Renamed in #444** (the bridge is no longer image-only):

| Kind | Was | Now |
|------|-----|-----|
| Error code | `image_ref_not_found` | `share_ref_not_found` |
| Error code | `image_too_large` | `file_too_large` |
| Error code | `unsupported_image_type` | `unsupported_file_type` |
| MCP tool | `share_image` | `share_file` (old name kept as a deprecated image-only alias; `share_file` can share arbitrary authorized workspace/media files) |
| Env vars | `IMAGE_SHARE_*` | `SHARE_*` (legacy names still read as a fallback) |
| SQLite table | `image_shares` | `file_shares` (renamed in place on first open) |

The error codes are the only breaking part: `code` values in `4xx` bodies changed.
HTTP statuses, request/response shapes and the token format are unchanged.

## Audio playback and fetch aliases

The channel speech pipeline can mint explicitly audio-scoped shares. These serve MP3 as `audio/mpeg` and M4A as `audio/mp4`, inline with `Accept-Ranges: bytes`; a valid single byte range returns `206` and `Content-Range`. Ordinary public mint requests remain image/PDF-only unless `allow_all_files` is explicitly set: `allow_documents` does not enable audio.

All fetch paths below accept `GET` and `HEAD`. Other methods return `405` with `Allow: GET, HEAD`. Every alias uses the same token lookup, expiry, containment, size and MIME revalidation; an audio suffix must match the actual file type or the request returns `404`.

| Canonical path | Direct gateway-prefix alias |
| --- | --- |
| `/shared/:token` | `/gateway/shared/:token` |
| `/shared/:token/audio.m4a` | `/gateway/shared/:token/audio.m4a` |
| `/shared/:token/audio.mp3` | `/gateway/shared/:token/audio.mp3` |
