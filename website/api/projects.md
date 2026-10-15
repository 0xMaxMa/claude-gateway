# Projects API {#projects-api}

Browse the project directories under the pod's projects root, `~/projects` by
default. The web dashboard uses these routes to list projects, create a new one,
show a read-only file tree and file viewer, and run a small set of git
operations (status, init, fetch, commit, pull, push). Editing files is out of scope.
Open the project in the code editor for that.

**Auth.** Every route needs an API key with pod-wide scope: `admin: true` or
`agents: "*"`. A key scoped to specific agents gets `403 forbidden_key`, because
projects belong to the pod, not to an agent. `POST /api/v1/projects`, `DELETE /api/v1/projects/:name` and every
`POST .../git/*` route also need `write: true` (or `admin: true`).

**Feature detection.** `GET /api/v1/capabilities` lists
`"projects": ["list", "create", "read", "git", "chat", "run", "start", "delete"]`. Show project browsing
only when the array includes `"list"`, the git UI only when it includes `"git"`,
and [project-bound chat](/api/sessions#post-apiv1agentsagentidsessions) only when
it includes `"chat"`. An older gateway omits the key, or lists projects without
`"git"`, `"chat"` or `"run"`. Show running status and the Stop button only when it includes `"run"`, the Start button only when it includes `"start"`, and the Delete action only when it includes `"delete"`.

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
| 403 | `path_escape` | The real path (after symlinks) leaves the project, or the project leaves the root or is the root itself (for example a link `all -> .`). |
| 403 | `permission_denied` | The gateway's user cannot read it. |
| 403 | `forbidden_key` | The key lacks pod-wide scope, or lacks write for a `POST`. |
| 404 | `not_found` | The project or path does not exist. |
| 400 | `confirm_mismatch` | `DELETE` did not send `confirm` equal to the project name. |
| 409 | `project_exists` | `POST` named a project, file or symlink that already exists, compared case-insensitively (`Site` collides with `site`). |
| 409 | `project_running` | `DELETE` found a process listening from inside the project. |
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
    { "name": "demo", "path": "/home/getpod/projects/demo", "modified_at": "2026-10-06T07:41:58.706Z", "is_git": true, "stack": "nextjs" }
  ]
}
```

`is_git` is true when the project has a `.git` entry (a directory, or the file a
worktree or submodule uses).

`stack` is a guess from the project's root files, or `null` when nothing marks one. It is one of
`nextjs`, `astro`, `react`, `vue`, `svelte`, `node`, `python`, `go`, `rust`, `ruby`, `php`, `java`
or `html`. A `package.json` decides first, by its dependencies (`next`, `astro`, `react`, `vue`,
`svelte`, else `node`). Without one, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`,
`composer.json`, `pom.xml` and similar files decide, and a lone `index.html` means `html`. Clients
should treat an unknown value as `null`.

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

If the name is already taken the response is `409 project_exists` and the
existing entry is not touched. The create is an atomic `mkdir`, so of several
concurrent requests for one name exactly one gets `201`. If `git init` fails, the directory is kept
and the response is still `201`, with a `warning`. The warning names only the
exit code, the signal, or the spawn error (such as `ENOENT` when git is not
installed). It never includes git's output, which the gateway logs instead.

```json
{
  "project": { "name": "nogit", "path": "/home/getpod/projects/nogit", "modified_at": "2026-10-06T07:41:58.698Z", "is_git": false },
  "warning": "git init failed (ENOENT)"
}
```

## DELETE /api/v1/projects/:name {#delete-project}

Delete `<root>/<name>` and everything in it. Returns `200` with `{ "name": "demo" }`. This cannot
be undone, and the gateway keeps no copy.

| Field | Required | Description |
|-------|----------|-------------|
| `confirm` | Yes | The project name again, exactly. Anything else is `400 confirm_mismatch`. |

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"confirm":"demo"}' http://localhost:10850/api/v1/projects/demo
```

While something listens on a port from inside the project, the response is `409 project_running`
and nothing is removed. Stop it first with [`running/stop`](#running). Links inside the project
are removed, never followed, so a link out of the project cannot delete what it points to. A
project that is itself a link out of the root answers `403 path_escape` and is left alone. Chats
that were started in the project are kept, and their project no longer resolves.

The folder is first moved to a hidden `<root>/.deleting-<name>-<id>` folder, so the project leaves
the list in one step and its name is free at once. If some files there cannot be removed, for
example a subfolder without write permission, the response is still `200` and adds a `warning`
naming the hidden folder that holds them. A project is never left listed with part of its files gone.

## GET /api/v1/projects/:name/tree {#get-tree}

List one directory level. Query `path` selects the directory (default: the
project root). Directories come first, then everything else, each group sorted
by name in code-unit order. Dotfiles are included. A name with a backslash is
left out, since `path` cannot name it. At most 2000 entries are
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
| `branch` | `string \| null` | Current branch, also before its first commit. `null` only when HEAD is detached. |
| `detached` | `boolean` | HEAD is detached. |
| `has_commits` | `boolean` | `false` right after `git init`. |
| `upstream` | `string \| null` | The upstream setting, such as `origin/main`, even when no online copy was found. |
| `ahead`, `behind` | `number` | Commits ahead of and behind the upstream, as of the last fetch. `0` when `sync` is `upstream_gone`. Before the first commit, `behind` counts every commit of the upstream. |
| `sync` | `string` | One of `in_sync`, `ahead`, `behind`, `diverged`, `no_upstream`, `upstream_gone`, `upstream_mismatch`, `no_remote`, `detached`. See [Sync values](#git-sync). Treat a value you do not know as neutral. |
| `remote` | `GitRemote \| null` | The upstream's remote, else `origin`, else the only remote. |
| `changes` | `GitFileChange[]` | At most 200, ordered conflicted, staged, unstaged, untracked. |
| `change_count` | `number` | The true number of changed files. |
| `conflicted_count` | `number` | Files with merge conflicts. |
| `truncated` | `boolean` | `changes` was cut at 200. |
| `last_commit` | `GitCommitInfo \| null` | The HEAD commit. |
| `operation` | `string` | `none`, `merge`, `rebase`, `cherry_pick`, `revert`, or `bisect`. |
| `identity_configured` | `boolean` | `user.name` and `user.email` both resolve for this repository. |
| `sensitive_untracked` | `string[]` | Paths that a commit would newly add and that look like secrets: untracked and not ignored, staged as added, added with `git add -N`, or the new name of a rename or copy. Not capped. The name is kept for compatibility. |

#### Sync values {#git-sync}

| `sync` | Meaning |
|--------|---------|
| `in_sync`, `ahead`, `behind`, `diverged` | Compared with the upstream, as of the last fetch. |
| `no_upstream` | A remote exists but the branch tracks nothing. Also a branch with no commits whose upstream has no commits online, such as a clone of an empty repository. |
| `upstream_gone` | The branch has commits and an upstream setting, but no online copy was found: it was removed, or it was never fetched. |
| `upstream_mismatch` | The upstream is not a branch of the same name on a configured remote, such as a branch made with `git checkout -b feature origin/main`, or one that tracks a local branch. `ahead` and `behind` are still reported. `push` refuses it with `409 upstream_mismatch`. |
| `no_remote` | The repository has no remote. |
| `detached` | HEAD is detached. |

A branch with no commits whose upstream has commits online reports `behind`
with `has_commits: false`, and `pull` fast-forwards it.

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
identity (`identity_missing`). When `git commit` itself fails, a locked index
(`index_locked`), nothing left to commit after staging (`nothing_to_commit`),
and a timeout (`timeout`) are reported first. Any other failure in a
repository with a `pre-commit`, `prepare-commit-msg`, or `commit-msg` hook is
`422 hook_failed`, with the output in `detail` cut to 2000 bytes, even when
the hook printed text that looks like a network or credential error. The
changes stay staged.

### POST /api/v1/projects/:name/git/pull {#post-git-pull}

Fetches the upstream's remote, then fast-forwards with
`git merge --ff-only @{upstream}`. `pull.rebase` and similar settings do not
apply. Returns `200` with `{ result: "up_to_date" | "fast_forwarded", status: GitStatus | null }`.
A diverged branch gets `409 not_fast_forward`. A branch whose upstream was
deleted on the remote gets `409 no_upstream`. A branch with no commits
fast-forwards to its upstream when the upstream has commits online, and gets
`409 no_upstream` when it has none. Local changes that the
fast-forward would overwrite get `409 dirty_would_overwrite`, and stay as they
were.

### POST /api/v1/projects/:name/git/push {#post-git-push}

Pushes the current branch to its upstream with an explicit, unforced refspec,
so a `+` refspec in `remote.<name>.push` never applies. A branch with no
commits gets `409 no_commits`, with or without an upstream. When `sync` is
`upstream_mismatch`, the response is `409 upstream_mismatch` and nothing is
pushed. With no upstream, it publishes the branch under the same name with
`git push -u -- <remote> <branch>` to the status's `remote`, the same remote
`fetch` uses. A `branch.<name>.remote` setting that names a remote that no
longer exists counts as no upstream. Both pushes pass the remote name after `--`, so a remote
named like an option, such as `--receive-pack=...`, is never read as one. When several remotes
leave `remote` as `null` (none is the upstream's or is named `origin`), the
response is `409 no_upstream`.
When `sync` is `upstream_gone`, the push publishes the branch again to the
same remote. Returns `200` with `{ status: GitStatus | null }`. A push the remote rejects as
non-fast-forward gets `409 not_fast_forward`. A push the remote refuses for
another reason, such as a protected branch or a server hook, gets
`409 remote_rejected`.

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
| 409 | `remote_rejected` | `push` refused by the remote, such as a protected branch or a server hook. |
| 409 | `dirty_would_overwrite` | `pull` blocked by local changes. |
| 409 | `no_remote` | `fetch`, `pull`, or `push` without a remote. |
| 409 | `no_upstream` | `pull` without an upstream or with one that was deleted on the remote, or `push` without one when the status `remote` is `null` because several remotes exist and none is named `origin`. |
| 409 | `upstream_mismatch` | `push` when `sync` is `upstream_mismatch`. |
| 409 | `no_commits` | `push` on a branch with no commits (`has_commits` is `false`). |
| 409 | `detached_head` | `commit`, `pull`, or `push` on a detached HEAD. |
| 409 | `busy` | Another git operation is running on this project. |
| 409 | `index_locked` | `.git/index.lock` exists, usually from another git process. |
| 422 | `hook_failed` | A commit failed in a repository with a commit hook, and the failure was not a locked index, nothing to commit, or a timeout. The body has `detail`, at most 2000 bytes. |
| 502 | `auth_failed` | The remote refused the credentials, or none were available. |
| 502 | `network` | The remote could not be reached. |
| 504 | `timeout` | Git ran past its limit: 3 seconds for the `GET` routes, 10 seconds for `init`, `identity`, and the status reads around every mutating route, 60 seconds for fetch, pull, push, and commit. |
| 500 | `git_failed` | Any other git failure. Git's output is not returned. |

## Running processes {#running}

A project counts as running when a process listens on a TCP port and either its
working directory is inside the project folder (`via: "cwd"`) or one of its
arguments is an absolute path inside the project folder (`via: "argv"`, for example
`python3 -m http.server --directory <project>` started from `/tmp`). Listening sockets come from `ss -H -ltnp`,
or from `/proc/net/tcp` and `/proc/<pid>/fd` when `ss` is missing. Every route here needs
a key that can see all agents. Stop also needs a write key.

### GET /api/v1/projects/:name/running {#get-running}

Returns `200` with one entry per port, sorted by port:

```json
{ "supported": true, "processes": [ { "port": 3000, "pids": [123, 456], "command": "node server.js", "address": "127.0.0.1", "via": "cwd" } ] }
```

`via` is `"cwd"` or `"argv"` and says how the first listener on that port was tied
to the project. A client that does not know the field can ignore it. `command` is the first listener's argument list joined by spaces and cut to 120
characters. The value after any flag whose name contains `token`, `password`,
`passwd`, `secret`, `key`, `auth`, `credential` or `bearer` (such as `--api-key`,
`--auth` or `--client-secret=...`) is replaced with `[redacted]`, and so is the value
after `-p` or attached to it (`-ppw`). A port passed as `-p 3000` is hidden too; the
entry's `port` still shows it. User and password in a URL (`postgres://user:pw@db/x`)
are removed. All of this happens before the cut. The environment is never returned. On a host that is not
Linux, or where `/proc` cannot be read, the response is
`{ "supported": false, "processes": [] }`.

### GET /api/v1/projects/running {#get-running-all}

Every project's listeners in one answer, for project cards. The gateway scans the
listening sockets once and ties each one to a project with the same rules, the same
`via` and the same `command` redaction as
[`GET /api/v1/projects/:name/running`](#get-running). Projects are the ones
[`GET /api/v1/projects`](#get-projects) lists: a symlink that leaves the root is
skipped. Only the first 200 projects, in name order, are looked at. A listener that
matches more than one project counts only for the deepest project folder. This
route never stops anything. It needs the same key as the per-project route.

Returns `200`. `projects` holds only the projects with at least one listener, in
name order, each with one entry per port sorted by port:

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects/running
```

```json
{
  "supported": true,
  "projects": {
    "api": [ { "port": 3000, "pids": [123], "command": "node server.js", "address": "127.0.0.1", "via": "cwd" } ],
    "docs": [ { "port": 8000, "pids": [456], "command": "python3 -m http.server 8000 --directory /home/me/projects/docs", "address": "0.0.0.0", "via": "argv" } ]
  }
}
```

On a host that is not Linux, or where `/proc` cannot be read, the response is
`{ "supported": false, "projects": {} }`. A project named `running` is still
reached by name at `/api/v1/projects/running/running`.

Errors: `403 forbidden_key`. A projects root that cannot be read gets the same
error as `GET /api/v1/projects`.

### POST /api/v1/projects/:name/running/stop {#post-running-stop}

Body `{}` stops every listener of the project. `{ "port": 3000 }` stops only that
port. A `port` that is not an integer from 1 to 65535 gets `400 invalid_port`.

The gateway sends SIGTERM to each listener pid and to its descendants, waits up to
3 seconds, sends SIGKILL to survivors, then scans again. Returns `200` with

```json
{ "stopped": [ { "port": 3000, "pids": [123] } ], "remaining": [ { "port": 3000, "pids": [123] } ] }
```

`remaining` lists whatever still listens. When nothing in the project matches, the
response is `409 nothing_running`. A second stop for the same project within one
second is ignored: it returns `200` with `stopped: []` and the current `remaining`.

Safety rules the gateway enforces:

- Only processes that own a LISTEN socket and whose working directory resolves (symlinks followed) inside the project folder are candidates. `projects/api` never matches `projects/api-v2`.
- A listener also qualifies when any argument is an absolute path (after stripping a leading `--flag=`) whose real path is the project folder or inside it. This covers the value after `--directory`, `--dir`, `-C`, `--cwd`, `--prefix` and `--root`. The comparison is the same as for the working directory. Relative paths, paths that leave the project through `..` or a symlink, environment variables, open files and substrings of the command line never count. A non-listening process that mentions the project is never touched.
- The gateway process, all of its ancestors, pid 1, any process whose executable or name is `claude` or `claude.exe`, and any process owned by another user are never signalled. A listener that is an ancestor of the gateway is skipped with its whole tree.
- Signals go to single pids, never to a process group or session.
- Before each signal the gateway checks the pid again: same start time, same owner, and for a listener still inside the project (by working directory or argument) and still listening. A pid that changed is skipped.

Errors: `400 invalid_name`, `400 invalid_port`, `403 forbidden_key`,
`403 path_escape`, `404 not_found`, `409 nothing_running`.

### POST /api/v1/projects/:name/running/start {#post-running-start}

Starts the project without an agent. Body `{}` picks the first free port from 3000
to 3099. `{ "port": 3005 }` asks for that port and gets `409 port_in_use` when
something listens on it.

The command is never taken from the request. The gateway builds it from the
project's own files, and `GET /api/v1/projects/:name/running` answers `start`
with `{ "command": "..." }` when it can start the project, `null` when it cannot.

- `package.json` with a `dev` script, else a `start` script. The gateway runs it with the lockfile's package manager (`npm`, `pnpm`, `yarn` or `bun`). A script that runs `vite`, `astro` or `next` also gets its port and host flags. Any other script gets the port only as the `PORT` environment variable.
- `main.py` or `app.py` with a top-level `app = FastAPI(`, and a `.venv` folder: `.venv/bin/uvicorn main:app --host 0.0.0.0 --port N`.

The process runs detached in the project folder with only `PATH`, `HOME`, `USER`,
`LOGNAME`, `LANG`, `LC_ALL`, `SHELL`, `TMPDIR` and `PORT` in its environment, and
its output goes to `~/.claude-gateway/logs/projects/<name>.log`. The response waits
up to 20 seconds for a listener on that port from inside the project, then returns
`200` with

```json
{ "port": 3001, "pid": 4242, "command": "PORT=3001 npm run start" }
```

On failure the body also carries `log`, the last 2000 characters of the output with
credentials and long tokens masked. A start that never listens is stopped again.

Errors: `400 invalid_name`, `400 invalid_port`, `403 forbidden_key`,
`403 path_escape`, `404 not_found`, `409 already_running`, `409 port_in_use`,
`409 no_free_port`, `422 no_start_command`, `502 start_failed`, `504 start_timeout`.
A second start while one is in flight for the same project gets `409 already_running`.
