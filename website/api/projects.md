# Projects API {#projects-api}

List the project directories under the pod's projects root, `~/projects` by
default. The web dashboard uses these routes to list projects, create and delete
one, read the git status of each project, and see, start and stop what runs in
it. The gateway does not serve project files: it has no route that lists a
project's folders or returns a file's contents. View project files in
code-server. Editing files and changing a repository (commit, push, pull) are
out of scope too. Use code-server or the git connector for that.

**Auth.** Projects belong to the pod, not to an agent, so any valid API key can read the list, git status and
running status. Creating, starting, stopping and deleting a project
change the pod and need an admin API key (`admin: true`). Any other key, a pod-wide write key included, gets
`403 forbidden_key` on those four routes, with the message `An admin API key is required for Projects`.
A project-bound chat belongs to its agent and follows the agent's rules like any other chat: see
[Sessions](/api/sessions#post-apiv1agentsagentidsessions).

**Feature detection.** `GET /api/v1/capabilities` lists
`"projects": ["list", "create", "git", "chat", "run", "start", "delete", "stop"]` for an admin key.
A key that is not an admin key gets `["list", "git", "chat", "run"]`. Show the project list
only when the array includes `"list"`, project create only when it includes `"create"`, the git status view only when it includes `"git"` (read-only: the gateway has no route that changes a repository),
and [project-bound chat](/api/sessions#post-apiv1agentsagentidsessions) only when
it includes `"chat"`. Show running status only when it includes `"run"`, the Stop button only when it includes `"stop"`, the Start button only when it includes `"start"`, and the Delete action only when it includes `"delete"`.
When the array is empty, `projectsUnavailable` is `"disabled"`: the gateway serves no Projects API. The field is
absent when Projects is usable. An older gateway omits the key, lists projects without
`"git"`, `"chat"`, `"run"` or `"stop"`, or answers `"admin_required"` for a key that is not an admin key.

**On by default.** The routes are on for every install, with the root `~/projects`, and
need no configuration. Every valid key can list the projects in that folder and read their git and running status, and every key with
`admin: true` can also create, start, stop and delete projects there. To switch Projects off, set
`gateway.projects.enabled` to `false` and restart. Only a boolean counts: the string `"false"`, `0` or `null` is
ignored with a warning in `gateway.log`, and Projects keeps its default, which is on:

```json
{ "gateway": { "projects": { "enabled": false } } }
```

**Security model.** An admin key can do everything, for every agent. Any other key reaches the agents it lists
(or every agent with `agents: "*"`), can write only when it has `write: true`, and can list every project
and read its git and running status. Admin-only means only create, start, stop and delete. The gateway does
not serve project files to any key, so files are viewed in code-server. The git routes remove credentials from
remote URLs. Every listing also carries the host path of the projects root as `root`, which usually includes the home directory.
These checks are not a filesystem boundary.
Agents run with `--dangerously-skip-permissions`, and a project-bound chat runs its agent inside the project
folder, so any key that can send that agent a message can ask it to read or change any file in the project, or
any other file the gateway's user can reach. Sending a message does not need `write`, so this includes a
read-only key that lists the agent. Projects are shared by every agent, so such a key can change a project that
other agents' chats also work in. On a host-mode orchestrated agent, `task_spawn` accepts any absolute
`working_directory`, so a worker can run inside a project folder without a project-bound chat. This predates
Projects. Treat an admin key as full access to the pod, and treat a key that can reach an agent as able to
change every project folder.

**Isolated memory agents.** An agent with `isolateMemory: true` can chat in a project like any other host agent, and the project is not split per conversation. Every chat bound to the project works in the same folder, so what one conversation writes there reaches the others. A trusted project also loads its own settings, hooks and `.mcp.json`, so its MCP servers reach the session although isolated memory mode gives a session none of the operator's. Bind a chat of an isolated agent only to a project its conversations may share, and leave that project out of `gateway.projects.trusted`. App agents cannot chat in a project (`409 project_unsupported_agent`, reason `container`).

**Root.** Projects live in `gateway.projects.root`, which defaults to
`~/projects`. Every listing returns the root as `root`, resolved through
symlinks when it exists, so a client never has to rebuild it. The gateway follows symlinks with `realpath` and refuses any project
whose real location is outside the root, or is the root itself.

**Disabled.** When the default root would expose your home or config directory, the gateway logs a warning and does not mount these routes: they answer `404`, `capabilities.projects` is empty, and `POST /sessions` with `project` answers `409 projects_disabled`. Sessions already bound to a project fail with `409 PROJECT_UNAVAILABLE`. Set `gateway.projects.root` to a folder that holds only projects to re-enable. A `root` that is spelled like the default, spaces and trailing slashes aside (`config.template.json` ships `"~/projects"`, and the config migration copies it into old configs) counts as unset, so it warns and disables the routes instead of stopping the gateway. Any other unsafe `root` stops the gateway from loading.

**Configuring the root.** Set `gateway.projects.root` in `config.json` to an
absolute path or a path starting with `~/`:

```json
{
  "gateway": {
    "projects": { "root": "/srv/projects" }
  }
}
```

The gateway rejects a configuration
whose root is `/`, your home directory, `~/.claude-gateway`, the directory holding
`config.json`, or any directory that contains one of them. Changing the root
takes effect after a gateway restart. The gateway trims the root and strips trailing slashes before it checks and
uses it, so `" ~/projects/ "` and `~/projects` are one root. A root holding `:` is not supported, because git's
discovery fence is a `:`-separated list: the gateway logs a warning and disables Projects. Keys other than `root`, `trusted` and `enabled`
inside `gateway.projects` are ignored, and the gateway logs a warning that names them.

**Requirements and files.** Projects needs `git` 2.26 or newer on the pod. The read calls
(`git status --porcelain=v2`, `rev-parse --absolute-git-dir`, `log`, `rev-list`) work from 2.13,
but the check that blanks a repository's own filter commands uses `git config --show-scope`
(2.26). On an older git that check finds nothing, and the filter protection below does not apply. Projects also uses
`ss`, or `/proc` when `ss` is missing, to find listeners, and writes these files:

| Path | Holds |
| ---- | ----- |
| `<agent dir>/project-bindings/<sessionId>.json` | Which project a chat is bound to. Written only for project chats and deleted with the session |
| `<gateway.logDir>/projects/<name>.log` | Output of a project started with `running/start`. With the default `logDir` this is `~/.claude-gateway/logs/projects/` |
| `<root>/.deleting-<name>-<id>` | What a `DELETE` could not remove. Safe to delete by hand |

**Downgrading.** Gateways without Projects ignore the `projects` block. A project chat opened
on this version then runs in the agent workspace, and a project task still queued at the time runs
without the untrusted-settings guard. Let queued project tasks finish, or cancel them, before you
downgrade.

## Errors {#errors}

Every error has the shape `{ "error": string, "code": string }`. Branch on
`code`; `error` is human-readable and may change. The git routes add their own
codes, listed under [Git errors](#git-errors).

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid_name` | The project name fails the name rules below. |
| 400 | `not_a_directory` | The project is a link to a file, or the root exists but is not a directory. |
| 403 | `path_escape` | The project's real path (after symlinks) leaves the root or is the root itself (for example a link `all -> .`). |
| 403 | `permission_denied` | The gateway's user cannot read it. |
| 403 | `forbidden_key` | Create, delete, stop or start with a key that is not an admin key. |
| 404 | `not_found` | The project does not exist. |
| 400 | `confirm_mismatch` | `DELETE` did not send `confirm` equal to the project name. |
| 409 | `project_exists` | `POST` named a project, file or symlink that already exists, compared case-insensitively (`Site` collides with `site`). |
| 409 | `project_running` | `DELETE` found a process listening from inside the project, a chat turn running in it (a turn still starting, an accepted message not yet handled, or a task that has not finished), a `running/start` still waiting for its listener, or a chat or task that works in the folder through a symlink alias. Deleting the chat session does not release it while its turn, accepted message or task is still live. |
| 409 | `project_deleting` | The project is being deleted. `running/start` arrived meanwhile, or a second `DELETE` of the same folder (by its name or through a symlink alias) found the delete already in progress. |
| 500 | `internal` | Anything else. |

**Project name.** Matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Directories under
the root whose names do not match are not listed.

## GET /api/v1/projects {#get-projects}

List the projects, sorted by name. Only directories, and symlinks that resolve
to a directory inside the root, are listed. When the root does not exist the
response has `exists: false`, and the gateway does not create it.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects
```

```json
{
  "root": "/home/user/projects",
  "exists": true,
  "projects": [
    { "name": "demo", "path": "/home/user/projects/demo", "modified_at": "2026-10-06T07:41:58.706Z", "is_git": true, "stack": "nextjs" }
  ]
}
```

Folders the list leaves out are reported in two optional arrays, so a client can tell the user
why a folder is missing. Both are absent when empty, and `projects` is not affected by them.

- `skipped` holds `{ "name", "reason" }` for each folder or link that is not a project, sorted by
  name, at most 50. `reason` is `invalid_name` (the [name rules](#errors) reject it: a space,
  non-ASCII letters, a leading dot or dash, or more than 64 characters), `symlink_outside_root` (a
  link whose target is outside the root, or is the root itself) or `not_a_directory` (a link to a file). Loose files and
  broken links are not reported.
- `leftovers` holds the names of hidden `.deleting-*` folders in the root, sorted, at most 50. They
  are what a [`DELETE`](#delete-project) could not remove. The gateway never sweeps them.

`is_git` is true when the project has a `.git` entry (a directory, or the file a
worktree or submodule uses).

`stack` is a guess from the project's root files, or `null` when nothing marks one. It is one of
`nextjs`, `astro`, `react`, `vue`, `svelte`, `node`, `python`, `go`, `rust`, `ruby`, `php`, `java`
or `html`. A `package.json` decides first, by its dependencies (`next`, `astro`, `react`, `vue`,
`svelte`, else `node`). Without one, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`,
`composer.json`, `pom.xml` and similar files decide, and a lone `index.html` means `html`. Clients
should treat an unknown value as `null`.

## POST /api/v1/projects {#post-projects}

Create `<root>/<name>`, creating the root first if needed. Needs an admin key. Returns
`201` with the new project in the same shape [the list](#get-projects) uses. Its `stack` is
`null`, since a new directory has no files to mark one.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Project name. |
| `git_init` | No | When `true`, run `git init -q` in the new directory (10 second timeout). |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"demo","git_init":true}' http://localhost:10850/api/v1/projects
```

```json
{ "project": { "name": "demo", "path": "/home/user/projects/demo", "modified_at": "2026-10-06T07:41:58.686Z", "is_git": true, "stack": null } }
```

If the name is already taken the response is `409 project_exists` and the
existing entry is not touched. The create is an atomic `mkdir`, so of several
concurrent requests for one name exactly one gets `201`. If `git init` fails, the directory is kept
and the response is still `201`, with a `warning`. The warning names only the
exit code, the signal, or the spawn error (such as `ENOENT` when git is not
installed). It never includes git's output, which the gateway logs instead.

```json
{
  "project": { "name": "nogit", "path": "/home/user/projects/nogit", "modified_at": "2026-10-06T07:41:58.698Z", "is_git": false, "stack": null },
  "warning": "git init failed (ENOENT)"
}
```

## DELETE /api/v1/projects/:name {#delete-project}

Delete `<root>/<name>` and everything in it. Needs an admin key. Returns `200` with `{ "name": "demo" }`. This cannot
be undone, and the gateway keeps no copy.

| Field | Required | Description |
|-------|----------|-------------|
| `confirm` | Yes | The project name again, exactly. Anything else is `400 confirm_mismatch`. |

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"confirm":"demo"}' http://localhost:10850/api/v1/projects/demo
```

While something listens on a port from inside the project, or a chat bound to the project has a
turn in flight, the response is `409 project_running` and nothing is removed. Stop the listener
with [`running/stop`](#running), or wait for or stop the chat turn. While a delete is in progress,
a message or task start in the project fails with `409 PROJECT_UNAVAILABLE` (`reason`
`project_deleting`), and a second `DELETE` answers `409 project_deleting`. Links inside the project
are removed, never followed, so a link out of the project cannot delete what it points to. A
project that is itself a link out of the root answers `403 path_escape` and is left alone. Chats
that were started in the project are kept, and their project no longer resolves.

The folder is first moved to a hidden `<root>/.deleting-<name>-<id>` folder, so the project leaves
the list in one step and its name is free at once. If some files there cannot be removed, for
example a subfolder without write permission, the response is still `200` and adds a `warning`
naming the exact folder to remove by hand (`rm -rf <root>/.deleting-<name>-<id>`). The folder is also listed in `leftovers` of [`GET /api/v1/projects`](#get-projects). A project is never left listed with part of its files gone.

## Git {#git}

The git routes read the status of a project that is a git repository. They
change nothing. A project is a repository only when its own directory holds the
repository. A plain folder inside a repository is not one. The gateway runs `git`
directly, never through a shell, and never prompts for credentials
(`GIT_TERMINAL_PROMPT=0`). To change a repository (commit, push, pull), use the
git connector or code-server. The one write is `git_init` on
[`POST /api/v1/projects`](#post-projects), which runs `git init -q` in the new,
empty directory.

Git, and every filter it starts, gets only these environment variables from the
gateway. Everything else, including the gateway's own API keys, bot tokens and
provider keys, is dropped.

| Variables | Why |
| --------- | --- |
| `PATH` | Finds `git` and the operator's filter programs, such as `git-lfs`. |
| `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM` | Select the operator's config files: filters (`git lfs install`), `safe.directory`. |
| `TMPDIR` | Temporary files. |

Git itself runs with `LC_ALL=C`. `GIT_DIR` and `GIT_WORK_TREE` from the gateway's
environment are never passed. When git runs past its time limit, the gateway
stops git and every process git started, such as filters. It sends `SIGTERM`
first so git removes its lock files, then `SIGKILL` one second later.

#### What a hostile repository cannot make a read run {#git-hostile}

A project folder can come from anywhere, and git runs commands that a
repository's own config names. Every read (`status`, `rev-parse`, `log`,
`rev-list`, `config`) and the `git init` of `git_init` run with these settings.

| Setting | What it stops |
| ------- | ------------- |
| `GIT_ALLOW_PROTOCOL` set empty | Every transport: ssh, http(s), git, file and `ext::`. A repository cannot undo it: `protocol.<name>.allow=always` in its config does not outrank the environment, though it does beat a global `protocol.allow=never`. Git can start a fetch during a read, to get an object a partial clone left out, so this is what keeps `core.sshCommand`, `core.askPass`, `remote.<name>.uploadpack`, `ext::` URLs and `credential.helper` from running. Such a read fails and the project reads as `null` in the list. `credential.helper` and `core.sshCommand` in the repository are never reached, because no connection is opened. |
| `GIT_NO_LAZY_FETCH=1` | Git 2.44 and later do not try the lazy fetch at all. Older git tries it and the line above stops it. |
| `core.fsmonitor=false` | The command named by `core.fsmonitor`. |
| Every `filter.*` key the repository defines set to empty | The filter drivers that the repository's own config defines. `status` runs a driver's clean command on any file whose timestamp changed, so it would run it. The gateway asks git for the drivers (`git config --list --show-scope`) and blanks those in the `local` and `worktree` scopes, which covers `.git/config`, `config.worktree`, files they include (also nested, and `includeIf`), a `.git` file that points elsewhere, and the config of a linked worktree's main repository. It does not parse config text. The driver is found whichever way `.gitattributes`, `.git/info/attributes` or `core.attributesFile` names it. The operator's own drivers in `~/.gitconfig` or `/etc/gitconfig` still run, such as `git lfs install`. A repository that defines `git lfs` locally (`git lfs install --local`) reads its LFS files as the raw pointer, so they can show as modified. |
| `--ignore-submodules=dirty` | `status` does not enter a submodule's worktree, where its own config and filters would apply. Only a changed submodule commit shows. |
| `--no-show-signature` on `log` | `log.showSignature` would run the repository's `gpg.program`. |
| `--no-optional-locks` | `status` never takes `.git/index.lock` from a git command you run in the same folder. |

The keys are passed to git whole, in its environment, which can carry only valid UTF-8. A repository is therefore
not read, and answers `409 git_unreadable` (`git-summary` shows `null` for it), when it defines more than 64
`filter.*` keys (a driver with `clean`, `smudge`, `process` and `required` counts 4, so about 16 drivers), a key
longer than 1024 characters, or a `filter.*` key that is not valid UTF-8.

Not neutralized, and not reachable from a read: hooks (`status`, `log` and
`rev-parse` run none), `diff` and `merge` drivers and textconv (not used by a
status), `core.pager`, `core.editor`. The operator's config is trusted: a
filter or `safe.directory` set in `~/.gitconfig` or `/etc/gitconfig` applies, and so do `HOME`, `XDG_CONFIG_HOME`,
`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM` from the gateway's environment. Its
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>` and `GIT_CONFIG_PARAMETERS` are dropped.

Credentials in a remote URL (`https://user:token@host/x`) are removed from
every git route response and log line. Git's own output never reaches the client.

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

#### Sync values {#git-sync}

| `sync` | Meaning |
|--------|---------|
| `in_sync`, `ahead`, `behind`, `diverged` | Compared with the upstream, as of the last fetch. |
| `no_upstream` | A remote exists but the branch tracks nothing. Also a branch with no commits whose upstream has no commits online, such as a clone of an empty repository. |
| `upstream_gone` | The branch has commits and an upstream setting, but no online copy was found: it was removed, or it was never fetched. |
| `upstream_mismatch` | The upstream is not a branch of the same name on a configured remote, such as a branch made with `git checkout -b feature origin/main`, or one that tracks a local branch. `ahead` and `behind` are still reported. |
| `no_remote` | The repository has no remote. |
| `detached` | HEAD is detached. |

A branch with no commits whose upstream has commits online reports `behind`
with `has_commits: false`.

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

### GET /api/v1/projects/git-summary {#get-git-summary}

A slim status for every project that is a git repository, for project cards.
Plain folders are left out. A repository whose status takes longer than 3
seconds or fails maps to `null`. The gateway reads at most 4 repositories at a
time, and each read runs 2 git processes one after the other (the config, then the status), so one request keeps up to 4
git processes running and spawns 2 per repository, 3 for an unborn branch that has an upstream (measured: 400 for 200 repositories with commits). `GET /api/v1/projects`
spawns none, since it only looks at the filesystem. To stay fast, `change_count` counts an untracked folder as one change,
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

Returns `200` with a [GitStatus](#git-status). A read spawns 4 git processes (5 for an unborn branch that has an upstream, which also counts the commits to pull): the config first, then `rev-parse`, `status` and `log` at once. The 3 second limit covers the whole read.

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
    { "path": "notes.md", "staged": null, "unstaged": "untracked" }
  ],
  "change_count": 2,
  "conflicted_count": 0,
  "truncated": false,
  "last_commit": { "sha": "5e67…", "subject": "Update readme", "author": "Ann Dev", "committed_at": "2026-10-07T12:20:33+07:00" },
  "operation": "none"
}
```

### Git errors {#git-errors}

| Status | `code` | When |
|--------|--------|------|
| 409 | `not_a_git_repo` | The project is not a repository. |
| 409 | `git_unsafe_owner` | The repository belongs to another user and git refuses it (`detected dubious ownership`). Run `git config --global --add safe.directory <path>` as the gateway's user, or change the owner. `git-summary` shows `null` for it and the other repositories still read. |
| 409 | `git_unreadable` | The folder has a `.git` that git cannot read: no permission, a `.git` file that points nowhere, a damaged config, or a repository that defines more `filter.*` keys than the gateway blanks. |
| 503 | `git_unavailable` | Git is not installed, or is not on the gateway's `PATH`. `git-summary` answers it too, since no repository can be read. The gateway logs a warning once. |
| 504 | `timeout` | Git ran past its limit of 3 seconds. |
| 500 | `git_failed` | Any other git failure. Git's output is not returned. |

## Running processes {#running}

A project counts as running when a process listens on a TCP port and either its
working directory is inside the project folder (`via: "cwd"`) or one of its
arguments is an absolute path inside the project folder (`via: "argv"`, for example
`python3 -m http.server --directory <project>` started from `/tmp`). Listening sockets come from `ss -H -ltnp`,
or from `/proc/net/tcp` and `/proc/<pid>/fd` when `ss` is missing. Any valid key can read
running status. Stop and start need an admin key.

### GET /api/v1/projects/:name/running {#get-running}

Returns `200` with one entry per port, sorted by port:

```json
{ "supported": true, "processes": [ { "port": 3000, "pids": [123, 456], "command": "node server.js", "address": "127.0.0.1", "via": "cwd" } ] }
```

`via` is `"cwd"` or `"argv"` and says how the first listener on that port was tied
to the project. A client that does not know the field can ignore it. `command` is the first listener's argument list joined by spaces and cut to 120
characters. The value after any flag whose name contains `token`, `password`,
`passwd`, `pass` (as a word of its own, so `--requirepass` but not `--passWithNoTests`), `secret`, `key`,
`auth`, `credential` or `bearer` (such as `--api-key`, `--auth`, `-passwd` or `--client-secret=...`)
is replaced with `[redacted]`. For `ttyd`, `-c user:pw` is too. `-p` is redacted by program. For `sshpass`, both
`-p pw` and `-ppw` are. For `mysql`, `mysqldump`, `mysqladmin`, `mariadb` and
`mariadb-dump`, the attached `-ppw` is, even when it is all digits; a bare `-p` is
left alone, since the next argument is a database name. For any other program only a
non-numeric `-ppw` is, so a port such as `-p 3000` or `-p3000` stays visible. User and password in a URL (`postgres://user:pw@db/x`)
are removed. All of this happens before the cut. The environment is never returned. On a host that is not
Linux, or where `/proc` cannot be read, the response is
`{ "supported": false, "processes": [] }`.

### GET /api/v1/projects/running {#get-running-all}

Every project's listeners in one answer, for project cards. The gateway scans the
listening sockets once and ties each one to a project with the same rules, the same
`via` and the same `command` redaction as
[`GET /api/v1/projects/:name/running`](#get-running). Projects are the ones
[`GET /api/v1/projects`](#get-projects) lists: a symlink that leaves the root is
skipped. Only the first 200 projects, in name order, are looked at, and `truncated` says whether more existed. A client must not read a missing project as "not running" when `truncated` is `true`; ask [`GET /api/v1/projects/:name/running`](#get-running) for it. A listener that
matches more than one project counts only for the deepest project folder. This
route never stops anything. It needs the same key as the per-project route.

Returns `200`. `projects` holds only the projects with at least one listener, in
name order, each with one entry per port sorted by port. `truncated` is `true` when
the root holds more than 200 projects and the rest were not scanned:

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/projects/running
```

```json
{
  "supported": true,
  "projects": {
    "api": [ { "port": 3000, "pids": [123], "command": "node server.js", "address": "127.0.0.1", "via": "cwd" } ],
    "docs": [ { "port": 8000, "pids": [456], "command": "python3 -m http.server 8000 --directory /home/me/projects/docs", "address": "0.0.0.0", "via": "argv" } ]
  },
  "truncated": false
}
```

On a host that is not Linux, or where `/proc` cannot be read, the response is
`{ "supported": false, "projects": {}, "truncated": false }`. A project named `running` is still
reached by name at `/api/v1/projects/running/running`.

Errors: a projects root that cannot be read gets the same error as `GET /api/v1/projects`.

### POST /api/v1/projects/:name/running/stop {#post-running-stop}

Needs an admin key. Body `{}` stops every listener of the project. `{ "port": 3000 }` stops only that
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

Starts the project without an agent. Needs an admin key. Body `{}` picks the first free port from 3000
to 3099. `{ "port": 3005 }` asks for that port and gets `409 port_in_use` when
something listens on it.

The gateway does not guess how to run a project. The project's agent writes
`.pod/start.sh` once, and a start only runs that file as `sh .pod/start.sh` in the
project folder, with `PORT` set to the port the gateway picked (or the one asked for).
The script must listen on `$PORT` and on `0.0.0.0`, and exit non-zero when it fails.
The command is never taken from the request.

The script must be a regular file (a symlink is refused), at most 64 KiB, and must
resolve inside the project. Without one, the start answers `422 no_start_command`
("The project has no start script yet"). `GET /api/v1/projects/:name/running` answers
`start` with `{ "command": "sh .pod/start.sh" }` when the script exists, `null` otherwise.

The process runs detached in the project folder with only `PATH`, `HOME`, `USER`,
`LOGNAME`, `LANG`, `LC_ALL`, `SHELL`, `TMPDIR` and `PORT` in its environment, and
its output goes to `<gateway.logDir>/projects/<name>.log` (`~/.claude-gateway/logs/projects/<name>.log` by default). The response waits
up to 20 seconds for a listener on that port from inside the project, then returns
`200` with

```json
{ "port": 3001, "pid": 4242, "command": "PORT=3001 sh .pod/start.sh" }
```

On failure the body also carries `log`, the last 2000 characters of the output with
credentials and long tokens masked. A start that never listens is stopped again. When the process could not be launched at all (for example the log folder is not writable), `start_failed` carries `reason`, an errno code such as `EACCES`, or `spawn_failed`, and the gateway logs the full error.

Errors: `400 invalid_name`, `400 invalid_port`, `403 forbidden_key`,
`403 path_escape`, `404 not_found`, `409 already_running`, `409 port_in_use`,
`409 no_free_port`, `409 project_deleting`, `422 no_start_command`, `502 start_failed`, `504 start_timeout`.
A second start while one is in flight for the same project gets `409 already_running`.
