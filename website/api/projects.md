# Projects API {#projects-api}

Browse the project directories under the pod's projects root, `~/projects` by
default. The web dashboard uses these routes to list projects, create a new one,
show a read-only file tree and file viewer, and run a small set of git
operations (status, init, fetch, commit, pull, push). Editing files is out of scope.
Open the project in the code editor for that.

**Auth.** Every route needs an API key with pod-wide scope: `admin: true` or
`agents: "*"`. A key scoped to specific agents gets `403 forbidden_key`, because
projects belong to the pod, not to an agent. `POST /api/v1/projects` and every
`POST .../git/*` route also need `write: true` (or `admin: true`).

**Feature detection.** `GET /api/v1/capabilities` lists
`"projects": ["list", "create", "read", "git"]`. Show project browsing only when
the array includes `"list"`, and the git UI only when it includes `"git"`. An
older gateway omits the key, or lists projects without `"git"`.

**Root.** Projects live in `gateway.projects.root`, which defaults to
`~/projects`. Every listing returns the root as `root`, resolved through
symlinks when it exists, so a client never has to rebuild it. The gateway follows symlinks with `realpath` and refuses any project, directory, or
file whose real location is outside the root (for a project) or outside the
project (for a path inside it). Hardlinks are not detected: a hardlinked file reads like any other file,
because the API is a view of what the gateway's user can already read, not a
sandbox.

**Configuring the root.** Set `gateway.projects.root` in `config.json` to an
absolute path or a path starting with `~/`:

```json
{
  "gateway": {
    "projects": { "root": "/srv/projects" }
  }
}
```

The API has no denylist inside the root, so the gateway rejects a configuration
whose root is `/`, your home directory, `~/.claude-gateway`, the directory holding
`config.json`, or any directory that contains one of them. Changing the root
takes effect after a gateway restart.

## Errors {#errors}

Every error has the shape `{ "error": string, "code": string }`. Branch on
`code`; `error` is human-readable and may change. The git routes add their own
codes, listed under [Git errors](#git-errors).

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid_name` | The project name fails the name rules below. |
| 400 | `invalid_path` | The `path` query fails the path rules below, or the filesystem rejects it as too long. |
| 400 | `not_a_directory` | `tree` was asked for a file, or the root exists but is not a directory. |
| 400 | `not_a_file` | `file` was asked for a directory or a special file. |
| 403 | `path_escape` | The real path (after symlinks) leaves the project, or the project leaves the root. |
| 403 | `permission_denied` | The gateway's user cannot read it. |
| 403 | `forbidden_key` | The key lacks pod-wide scope, or lacks write for a `POST`. |
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
to a directory inside the root, are listed. When the root does not exist the
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

Create `<root>/<name>`, creating the root first if needed. Returns
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
and the response is still `201`, with a `warning`. The warning names only the
exit code, the signal, or the spawn error (such as `ENOENT` when git is not
installed). It never includes git's output, which the gateway logs instead.

```json
{
  "project": { "name": "nogit", "path": "/home/getpod/projects/nogit", "modified_at": "2026-10-06T07:41:58.698Z", "is_git": false },
  "warning": "git init failed (ENOENT)"
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

## Git {#git}

The git routes act on a project that is a git repository. A project is a
repository only when its own directory holds the repository. A plain folder
inside a repository is not one. The gateway runs `git` directly, never through
a shell, without any `GIT_*` variable from its own environment, and never
prompts for credentials. For ssh it uses `ssh -o BatchMode=yes` unless the
repository sets `core.sshCommand`. It never forces, never skips hooks, and
never resets, checks out, or deletes anything.

Reads run with `core.fsmonitor` turned off, so listing projects never runs a
command from a repository's config. When git runs past its time limit, the
gateway stops git and every process git started, such as hooks, filters, and
ssh. It sends `SIGTERM` first so git removes its lock files, then `SIGKILL`
one second later.

Only one mutating git route runs per project at a time. A second one gets
`409 busy`. Reads never wait for a mutation.

A mutating route reads the status before and after it runs git, with a 10
second limit for each read. When git succeeded but the status read after it
fails, the route still returns its success code. The status in the body is
then `null`: the whole body for `init`, `fetch`, and `identity`, and the
`status` field for `commit`, `pull`, and `push`. Fetch
[the status](#get-git) again to show it.

Credentials in a remote URL (`https://user:token@host/x`) are removed from
every response and log line. Git's own output never reaches the client, except
for the `detail` of `hook_failed`.

### GitStatus {#git-status}

| Field | Type | Meaning |
|-------|------|---------|
| `branch` | `string \| null` | Current branch. `null` when HEAD is detached, or the branch has no commits yet. |
| `detached` | `boolean` | HEAD is detached. |
| `has_commits` | `boolean` | `false` right after `git init`. |
| `upstream` | `string \| null` | The upstream, such as `origin/main`. |
| `ahead`, `behind` | `number` | Commits ahead of and behind the upstream, as of the last fetch. `0` when `sync` is `upstream_gone`. |
| `sync` | `string` | One of `in_sync`, `ahead`, `behind`, `diverged`, `no_upstream` (a remote exists but the branch tracks nothing), `upstream_gone` (the branch tracks an online branch that was deleted, as of the last fetch), `no_remote`, `detached`. Treat a value you do not know as neutral. |
| `remote` | `GitRemote \| null` | The upstream's remote, else `origin`, else the only remote. |
| `changes` | `GitFileChange[]` | At most 200, ordered conflicted, staged, unstaged, untracked. |
| `change_count` | `number` | The true number of changed files. |
| `conflicted_count` | `number` | Files with merge conflicts. |
| `truncated` | `boolean` | `changes` was cut at 200. |
| `last_commit` | `GitCommitInfo \| null` | The HEAD commit. |
| `operation` | `string` | `none`, `merge`, `rebase`, `cherry_pick`, `revert`, or `bisect`. |
| `identity_configured` | `boolean` | `user.name` and `user.email` both resolve for this repository. |
| `sensitive_untracked` | `string[]` | Paths that a commit would newly add and that look like secrets: untracked and not ignored, staged as added, added with `git add -N`, or the new name of a rename or copy. Not capped. The name is kept for compatibility. |

`GitFileChange` is `{ path, orig_path?, staged, unstaged }`. `path` is relative
to the project with forward slashes. `orig_path` is set for renames and copies.
`staged` and `unstaged` are each `null` or one of `added`, `modified`,
`deleted`, `renamed`, `copied`, `type_changed`, `untracked` (unstaged only), or
`conflicted` (on both sides).

`GitRemote` is `{ name, url, host, web_url }`. `host` is `github`, `gitlab`,
`bitbucket`, or `other`. `web_url` is the repository's web page for the first
three, else `null`.

`GitCommitInfo` is `{ sha, subject, author, committed_at }`, with
`committed_at` in ISO 8601.

A file looks like a secret when its name is `.env`, `.env.*` (except
`.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.key`, `id_rsa`,
`id_dsa`, `id_ecdsa`, `id_ed25519`, `*.p12`, `*.pfx`, `.npmrc`,
`credentials.json`, `service-account*.json`, `.netrc`, or `.git-credentials`.
The match ignores case, so `.ENV` and `ID_RSA` count too.

### GET /api/v1/projects/git-summary {#get-git-summary}

A slim status for every project that is a git repository, for project cards.
Plain folders are left out. A repository whose status takes longer than 3
seconds or fails maps to `null`. The gateway reads at most 4 repositories at a
time. To stay fast, `change_count` counts an untracked folder as one change,
so it can be lower than the `change_count` of the full status.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects/git-summary
```

```json
{
  "summaries": {
    "app": { "branch": "main", "detached": false, "sync": "in_sync", "ahead": 0, "behind": 0, "change_count": 0, "conflicted_count": 0, "remote_host": "github" },
    "slow": null
  }
}
```

### GET /api/v1/projects/:name/git {#get-git}

Returns `200` with a [GitStatus](#git-status). Reads time out after 3 seconds.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects/app/git
```

```json
{
  "branch": "main",
  "detached": false,
  "has_commits": true,
  "upstream": "origin/main",
  "ahead": 1,
  "behind": 0,
  "sync": "ahead",
  "remote": { "name": "origin", "url": "https://github.com/acme/app.git", "host": "github", "web_url": "https://github.com/acme/app" },
  "changes": [
    { "path": "README.md", "staged": null, "unstaged": "modified" },
    { "path": ".env", "staged": null, "unstaged": "untracked" }
  ],
  "change_count": 2,
  "conflicted_count": 0,
  "truncated": false,
  "last_commit": { "sha": "5e67…", "subject": "Update readme", "author": "Ann Dev", "committed_at": "2026-10-07T12:20:33+07:00" },
  "operation": "none",
  "identity_configured": true,
  "sensitive_untracked": [".env"]
}
```

### POST /api/v1/projects/:name/git/init {#post-git-init}

Runs `git init` in a project that is not yet a repository. Returns `201` with
a [GitStatus](#git-status) or `null`, or `409 already_a_git_repo`.

### POST /api/v1/projects/:name/git/fetch {#post-git-fetch}

Runs `git fetch --prune` from the status's `remote`. Returns `200` with a
[GitStatus](#git-status), whose `ahead` and `behind` are now current, or `null`.

### POST /api/v1/projects/:name/git/identity {#post-git-identity}

Writes `user.name` and `user.email` to the repository's own config. Refused
with `409 identity_already_set` when both already resolve, from any config
file. Returns `200` with a [GitStatus](#git-status) or `null`.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | 1 to 100 characters after trimming, with no `<`, `>`, or control characters. |
| `email` | Yes | One `@`, no whitespace, `<`, or `>`, at most 254 characters. |

### POST /api/v1/projects/:name/git/commit {#post-git-commit}

Stages every change (`git add -A`), then commits. Returns `201` with
`{ commit: GitCommitInfo | null, status: GitStatus | null }`. `commit` is
`null` only when the gateway could not read the new commit back; the commit
was still made. Hooks run, with a 60 second limit.

| Field | Required | Description |
|-------|----------|-------------|
| `message` | Yes | The commit message. Trimmed. Empty means `400 message_required`. |
| `allow_sensitive` | No | `string[]`, the secret-looking paths the user confirmed. The commit runs only when every path in the current `sensitive_untracked` is in this list. Otherwise the response is `409 sensitive_files`, whose `paths` lists the current paths that were not confirmed. Paths in the list that are no longer in `sensitive_untracked` are ignored. Any value that is not an array of strings, such as `true`, gets `400 invalid_allow_sensitive`. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"message":"Update readme"}' http://localhost:10850/api/v1/projects/app/git/commit
```

```json
{ "error": "New files look like secrets", "code": "sensitive_files", "paths": [".env"] }
```

Send the paths the user saw and confirmed, not a stored list from an earlier
status. A secret file that appears after the user looked is then refused again.

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"message":"Update readme","allow_sensitive":[".env"]}' http://localhost:10850/api/v1/projects/app/git/commit
```

The commit is refused while conflicts exist (`conflicts_present`), during a
merge or similar (`operation_in_progress`), on a detached HEAD
(`detached_head`), with nothing to commit (`nothing_to_commit`), or without an
identity (`identity_missing`). When a hook rejects the commit, the response is
`422 hook_failed` with the hook's output in `detail`, cut to 2000 bytes. The
changes stay staged.

### POST /api/v1/projects/:name/git/pull {#post-git-pull}

Fetches the upstream's remote, then fast-forwards with
`git merge --ff-only @{upstream}`. `pull.rebase` and similar settings do not
apply. Returns `200` with `{ result: "up_to_date" | "fast_forwarded", status: GitStatus | null }`.
A diverged branch gets `409 not_fast_forward`. A branch whose upstream was
deleted on the remote gets `409 no_upstream`. Local changes that the
fast-forward would overwrite get `409 dirty_would_overwrite`, and stay as they
were.

### POST /api/v1/projects/:name/git/push {#post-git-push}

Pushes the current branch to its upstream with an explicit, unforced refspec,
so a `+` refspec in `remote.<name>.push` never applies. The gateway pushes only
when the upstream branch has the same name as the local branch. A branch
created with `git checkout -b feature origin/main` tracks `main`, so the
response is `409 upstream_mismatch` and nothing is pushed. With no upstream, it
publishes the branch under the same name with `git push -u <remote> <branch>`
to the status's `remote`, the same remote `fetch` uses. When several remotes
leave `remote` as `null` (none is the upstream's or is named `origin`), the
response is `409 no_upstream`.
When `sync` is `upstream_gone`, the push publishes the branch again to the
same remote. Returns `200` with `{ status: GitStatus | null }`. A push the remote rejects as
non-fast-forward gets `409 not_fast_forward`.

### Git errors {#git-errors}

| Status | `code` | When |
|--------|--------|------|
| 400 | `message_required` | `commit` without a non-empty `message`. |
| 400 | `invalid_allow_sensitive` | `commit` with an `allow_sensitive` that is not an array of strings. |
| 400 | `invalid_identity` | `identity` with a missing or invalid `name` or `email`. |
| 409 | `not_a_git_repo` | The project is not a repository. |
| 409 | `already_a_git_repo` | `init` on a repository. |
| 409 | `nothing_to_commit` | `commit` on a clean tree. |
| 409 | `identity_missing` | `commit` without `user.name` and `user.email`. |
| 409 | `identity_already_set` | `identity` when both already resolve. |
| 409 | `sensitive_files` | `commit` would newly add secret-looking files that `allow_sensitive` does not list. The body has `paths`, the unconfirmed ones. |
| 409 | `conflicts_present` | `commit`, `pull`, or `push` while files have merge conflicts. |
| 409 | `operation_in_progress` | `commit`, `pull`, or `push` during a merge, rebase, cherry-pick, revert, or bisect. |
| 409 | `not_fast_forward` | `pull` on a diverged branch, or `push` rejected as non-fast-forward. |
| 409 | `dirty_would_overwrite` | `pull` blocked by local changes. |
| 409 | `no_remote` | `fetch`, `pull`, or `push` without a remote. |
| 409 | `no_upstream` | `pull` without an upstream or with one that was deleted on the remote, or `push` without one when the status `remote` is `null` because several remotes exist and none is named `origin`. |
| 409 | `upstream_mismatch` | `push` on a branch whose upstream has a different branch name, or lives on a remote that is not configured. |
| 409 | `detached_head` | `commit`, `pull`, or `push` on a detached HEAD. |
| 409 | `busy` | Another git operation is running on this project. |
| 409 | `index_locked` | `.git/index.lock` exists, usually from another git process. |
| 422 | `hook_failed` | A commit hook failed. The body has `detail`, at most 2000 bytes. |
| 502 | `auth_failed` | The remote refused the credentials, or none were available. |
| 502 | `network` | The remote could not be reached. |
| 504 | `timeout` | Git ran past its limit: 3 seconds for the `GET` routes, 10 seconds for `init`, `identity`, and the status reads around every mutating route, 60 seconds for fetch, pull, push, and commit. |
| 500 | `git_failed` | Any other git failure. Git's output is not returned. |
