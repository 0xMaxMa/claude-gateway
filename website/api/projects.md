# Projects API {#projects-api}

Browse the project directories under the pod user's `~/projects`. The web
dashboard uses these routes to list projects, create a new one, and show a
read-only file tree and file viewer. Editing is out of scope. Open the project
in the code editor for that.

**Auth.** Every route needs an API key with pod-wide scope: `admin: true` or
`agents: "*"`. A key scoped to specific agents gets `403 forbidden_key`, because
projects belong to the pod, not to an agent. `POST /api/v1/projects` also needs
`write: true` (or `admin: true`).

**Feature detection.** `GET /api/v1/capabilities` lists
`"projects": ["list", "create", "read"]`. Show project browsing only when the
array includes `"list"`. An older gateway omits the key.

**Root.** Projects live in `path.join(os.homedir(), "projects")`. Every listing
returns this as `root`, so a client never has to rebuild the home path. The
gateway follows symlinks with `realpath` and refuses any project, directory, or
file whose real location is outside the root (for a project) or outside the
project (for a path inside it).

## Errors {#errors}

Every error has the shape `{ "error": string, "code": string }`. Branch on
`code`; `error` is human-readable and may change.

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid_name` | The project name fails the name rules below. |
| 400 | `invalid_path` | The `path` query fails the path rules below. |
| 400 | `not_a_directory` | `tree` was asked for a file. |
| 400 | `not_a_file` | `file` was asked for a directory or a special file. |
| 403 | `path_escape` | The real path (after symlinks) leaves the project, or the project leaves the root. |
| 403 | `permission_denied` | The gateway's user cannot read it. |
| 403 | `forbidden_key` | The key lacks pod-wide scope, or lacks write for `POST`. |
| 404 | `not_found` | The project or path does not exist. |
| 409 | `project_exists` | `POST` named a project that already exists. |
| 500 | `internal` | Anything else. |

**Project name.** Matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Directories under
the root whose names do not match are not listed.

**Path.** A POSIX path relative to the project. The empty string (or no `path`
query) is the project directory. A path must not start with `/`, contain a
backslash or NUL, contain an empty, `.`, or `..` segment, or exceed 4096
characters.

## GET /api/v1/projects {#get-projects}

List the projects, sorted by name. Only directories, and symlinks that resolve
to a directory inside the root, are listed. When `~/projects` does not exist the
response has `exists: false`, and the gateway does not create it.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects
```

```json
{
  "root": "/home/getpod/projects",
  "exists": true,
  "projects": [
    { "name": "demo", "path": "/home/getpod/projects/demo", "modified_at": "2026-10-06T07:41:58.706Z", "is_git": true }
  ]
}
```

`is_git` is true when the project has a `.git` entry (a directory, or the file a
worktree or submodule uses).

## POST /api/v1/projects {#post-projects}

Create `~/projects/<name>`, creating `~/projects` first if needed. Returns
`201`.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Project name. |
| `git_init` | No | When `true`, run `git init -q` in the new directory (10 second timeout). |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"demo","git_init":true}' http://localhost:10850/api/v1/projects
```

```json
{ "project": { "name": "demo", "path": "/home/getpod/projects/demo", "modified_at": "2026-10-06T07:41:58.686Z", "is_git": true } }
```

If the project already exists the response is `409 project_exists` and the
existing directory is not touched. If `git init` fails, the directory is kept
and the response is still `201`, with a `warning`:

```json
{
  "project": { "name": "nogit", "path": "/home/getpod/projects/nogit", "modified_at": "2026-10-06T07:41:58.698Z", "is_git": false },
  "warning": "git init failed: spawn git ENOENT"
}
```

## GET /api/v1/projects/:name/tree {#get-tree}

List one directory level. Query `path` selects the directory (default: the
project root). Directories come first, then everything else, each group sorted
by name in code-unit order. Dotfiles are included. At most 2000 entries are
returned; `truncated` is `true` when there were more.

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:10850/api/v1/projects/demo/tree?path="
```

```json
{
  "path": "",
  "entries": [
    { "kind": "dir", "name": "src", "path": "src", "modified_at": "2026-10-06T07:41:58.705Z" },
    { "kind": "file", "name": "README.md", "path": "README.md", "size": 7, "modified_at": "2026-10-06T07:41:58.705Z" },
    { "kind": "symlink", "name": "passwd", "path": "passwd", "target_kind": "outside" }
  ],
  "truncated": false
}
```

| `kind` | Fields | Notes |
|--------|--------|-------|
| `dir` | `name`, `path`, `modified_at` | |
| `file` | `name`, `path`, `size`, `modified_at` | `size` in bytes. |
| `symlink` | `name`, `path`, `target_kind` | Never followed. `target_kind` is `file`, `dir`, `outside` (resolves outside the project), or `dangling`. |
| `other` | `name`, `path` | Sockets, FIFOs, devices. |

`path` on each entry is the value to pass back as the `path` query.

## GET /api/v1/projects/:name/file {#get-file}

Read one file. Always `200` for a regular file; `kind` says what you got.

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:10850/api/v1/projects/demo/file?path=src/index.ts"
```

| `kind` | Fields | When |
|--------|--------|------|
| `text` | `path`, `size`, `modified_at`, `content` | Valid UTF-8 with no NUL byte in the first 8 KiB. `content` is byte-exact, including any BOM and trailing newline. |
| `binary` | `path`, `size`, `modified_at` | Anything else. |
| `too_large` | `path`, `size`, `modified_at`, `limit` | Larger than `limit` (1 MiB). The gateway does not read the file. |

```json
{ "kind": "text", "path": "src/index.ts", "size": 22, "modified_at": "2026-10-06T07:41:58.705Z", "content": "  export const x = 1;\n" }
```

```json
{ "kind": "too_large", "path": "big.log", "size": 1048577, "modified_at": "2026-10-06T07:41:58.705Z", "limit": 1048576 }
```

A symlink inside the project to a file inside the same project is followed. A
symlink whose target is outside the project returns `403 path_escape`.
