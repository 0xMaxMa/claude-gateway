# Git API {#git-api}

Read the git status of folders under the [files root](/api/files). The routes change nothing. A folder is a
repository only when its own directory holds the repository. A plain folder inside a repository is not one. Paths
follow the [files path rules](/api/files#paths): relative to the root, each segment checked, resolved through
symlinks, never outside the root. Errors use the one [error table](/api/files#errors).

**Auth and feature detection.** Any valid API key can read. `GET /api/v1/capabilities` lists
`"git": ["status", "summary"]`. Show the status view only when it includes `"status"`, and summaries only when it
includes `"summary"`.

## Requirements {#requirements}

The git routes need `git` 2.26 or newer on the pod. The read calls (`git status --porcelain=v2`,
`rev-parse --absolute-git-dir`, `log`, `rev-list`) work from 2.13, but the check that blanks a repository's own filter
commands uses `git config --show-scope` (2.26). On an older git that check finds nothing, and the filter protection
below does not apply.

## How git runs {#how-git-runs}


The gateway runs `git`
directly, never through a shell, and never prompts for credentials
(`GIT_TERMINAL_PROMPT=0`). To change a repository (commit, push, pull), use the
git connector or code-server. The one write is `git_init` on
[`POST /api/v1/files/mkdir`](/api/files#post-files-mkdir), which runs `git init -q` in the new,
empty folder.

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

### What a hostile repository cannot make a read run {#git-hostile}

A folder can come from anywhere, and git runs commands that a
repository's own config names. Every read (`status`, `rev-parse`, `log`,
`rev-list`, `config`) and the `git init` of `git_init` run with these settings.

| Setting | What it stops |
| ------- | ------------- |
| `GIT_ALLOW_PROTOCOL` set empty | Every transport: ssh, http(s), git, file and `ext::`. A repository cannot undo it: `protocol.<name>.allow=always` in its config does not outrank the environment, though it does beat a global `protocol.allow=never`. Git can start a fetch during a read, to get an object a partial clone left out, so this is what keeps `core.sshCommand`, `core.askPass`, `remote.<name>.uploadpack`, `ext::` URLs and `credential.helper` from running. Such a read fails and the folder reads as `null` in a summary. `credential.helper` and `core.sshCommand` in the repository are never reached, because no connection is opened. |
| `GIT_NO_LAZY_FETCH=1` | Git 2.44 and later do not try the lazy fetch at all. Older git tries it and the line above stops it. |
| `core.fsmonitor=false` | The command named by `core.fsmonitor`. |
| Every `filter.*` key the repository defines set to empty | The filter drivers that the repository's own config defines. `status` runs a driver's clean command on any file whose timestamp changed, so it would run it. The gateway asks git for the drivers (`git config --list --show-scope`) and blanks those in the `local` and `worktree` scopes, which covers `.git/config`, `config.worktree`, files they include (also nested, and `includeIf`), a `.git` file that points elsewhere, and the config of a linked worktree's main repository. It does not parse config text. The driver is found whichever way `.gitattributes`, `.git/info/attributes` or `core.attributesFile` names it. The operator's own drivers in `~/.gitconfig` or `/etc/gitconfig` still run, such as `git lfs install`. A repository that defines `git lfs` locally (`git lfs install --local`) reads its LFS files as the raw pointer, so they can show as modified. |
| `--ignore-submodules=dirty` | `status` does not enter a submodule's worktree, where its own config and filters would apply. Only a changed submodule commit shows. |
| `--no-show-signature` on `log` | `log.showSignature` would run the repository's `gpg.program`. |
| `--no-optional-locks` | `status` never takes `.git/index.lock` from a git command you run in the same folder. |

The keys are passed to git whole, in its environment, which can carry only valid UTF-8. A repository is therefore
not read, and answers `409 git_unreadable` (a summary shows `null` for it), when it defines more than 64
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

## GitStatus {#git-status}

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

### Sync values {#git-sync}

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
to the repository folder with forward slashes. `orig_path` is set for renames and copies.
`staged` and `unstaged` are each `null` or one of `added`, `modified`,
`deleted`, `renamed`, `copied`, `type_changed`, `untracked` (unstaged only), or
`conflicted` (on both sides).

`GitRemote` is `{ name, url, host, web_url }`. `host` is `github`, `gitlab`,
`bitbucket`, or `other`. `web_url` is the repository's web page for the first
three, else `null`.

`GitCommitInfo` is `{ sha, subject, author, committed_at }`, with
`committed_at` in ISO 8601.

## GET /api/v1/git/status {#get-git-status}

Returns `200` with a [GitStatus](#git-status) of the folder `path` names. `path` is required: the root itself is
`400 invalid_path`. A read spawns 4 git processes (5 for an unborn branch that has an upstream, which also counts the
commits to pull): the config first, then `rev-parse`, `status` and `log` at once. The 3 second limit covers the whole
read.

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:10850/api/v1/git/status?path=app"
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

## GET /api/v1/git/summary {#get-git-summary}

A slim status for every repository directly under `path`, keyed by folder name. Absent or empty `path` means the root.
Plain folders are left out. A repository whose status takes longer than 3 seconds or fails maps to `null`. The gateway
reads at most 4 repositories at a time, and each read runs 2 git processes one after the other (the config, then the
status), so one request keeps up to 4 git processes running and spawns 2 per repository, 3 for an unborn branch that
has an upstream. [`GET /api/v1/files`](/api/files#get-files) spawns none, since it only looks at the filesystem. To
stay fast, `change_count` counts an untracked folder as one change, so it can be lower than the `change_count` of the
full status.

```bash
curl -H "Authorization: Bearer $KEY" http://localhost:10850/api/v1/git/summary
```

```json
{
  "summaries": {
    "app": { "branch": "main", "detached": false, "sync": "in_sync", "ahead": 0, "behind": 0, "change_count": 0, "conflicted_count": 0, "remote_host": "github" },
    "slow": null
  }
}
```

## Git errors {#git-errors}

The codes below are in the one [error table](/api/files#errors); this is what each means for a git read.

| Status | `code` | When |
|--------|--------|------|
| 409 | `not_a_git_repo` | The folder is not a repository. |
| 409 | `git_unsafe_owner` | The repository belongs to another user and git refuses it (`detected dubious ownership`). Run `git config --global --add safe.directory <path>` as the gateway's user, or change the owner. A summary shows `null` for it and the other repositories still read. |
| 409 | `git_unreadable` | The folder has a `.git` that git cannot read: no permission, a `.git` file that points nowhere, a damaged config, or a repository that defines more `filter.*` keys than the gateway blanks. |
| 503 | `git_unavailable` | Git is not installed, or is not on the gateway's `PATH`. A summary answers it too, since no repository can be read. The gateway logs a warning once. |
| 504 | `timeout` | Git ran past its limit of 3 seconds. |
| 500 | `git_failed` | Any other git failure. Git's output is not returned. |
