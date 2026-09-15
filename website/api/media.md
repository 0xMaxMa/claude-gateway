# Media API {#media-api}

Upload and serve media files (images and PDFs) associated with an agent. Uploaded files are stored in the agent's media directory and can be referenced in messages via `media_files[]`.

## POST /api/v1/agents/:agentId/media {#post-apiv1agentsagentidmedia}

Upload a media file as a raw binary body. Supported MIME types: `image/*`, `application/pdf`.

**Request headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | MIME type of the file (e.g. `image/jpeg`, `application/pdf`) |
| `X-Filename` | No | Original filename — used to preserve extension |

```bash
curl -X POST \
  -H "X-Api-Key: my-secret-key-123" \
  -H "Content-Type: image/jpeg" \
  -H "X-Filename: photo.jpg" \
  --data-binary @/path/to/photo.jpg \
  http://localhost:10850/api/v1/agents/alfred/media | jq
```

```json
{ "mediaPath": "ui-upload/2026-05-10/gw-1746837600000.jpg" }
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | No file body received |
| 403 | Key has no access to agent |
| 404 | Agent not found |
| 413 | File exceeds max upload size |
| 415 | Unsupported MIME type |

---

## GET /api/v1/agents/:agentId/media/* {#get-apiv1agentsagentidmedia}

Serve a media file by path. The path must stay within the agent's media directory.

```bash
curl -H "X-Api-Key: my-secret-key-123" \
  "http://localhost:10850/api/v1/agents/alfred/media/ui-upload/2026-05-10/gw-1746837600000.jpg" \
  --output photo.jpg
```

**Error responses:**

| Status | When |
|--------|------|
| 400 | Path traversal attempt or invalid path |
| 403 | Key has no access to agent |
| 404 | Agent or file not found |

---
