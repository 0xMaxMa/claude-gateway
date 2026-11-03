# Files API {#files-api}

List, create and delete folders under one pod-wide root, `~/projects` by default. The gateway does not serve file
contents: it has no route that lists a folder's files or returns a file. View files in code-server. The read-only
[Git API](/api/git) reports the git status of folders under the same root.

Every path in a request is **relative to the root**. A path is a list of folder names joined by `/`, such as
`site` or `site/web`. The empty path, or no `path` at all, names the root. Every response that names a folder also
carries `abs`, its absolute path on the pod, so a client never has to join paths itself.

**Auth.** The folders belong to the pod, not to an agent, so any valid API key can list them. Creating and deleting a
folder change the pod and need an admin API key (`admin: true`). The [marks](#marks) routes need one too. Any other
key, a pod-wide write key included, gets `403 forbidden_key` on those routes.

**Feature detection.** `GET /api/v1/capabilities` lists `"files": ["list", "create", "delete", "marks"]` and
`"git": ["status", "summary"]` for an admin key. A key that is not an admin key gets `"files": ["list"]`. Show a
listing only when `files` includes `"list"`, folder create only when it includes `"create"`, and the Delete action
only when it includes `"delete"`. Call the [busy and marks routes](#marks) only when it includes `"marks"`. When the
files API is off, `files`, `git` and `sessions` are empty and
`filesUnavailable` is `"disabled"`. While the API is on, the top-level `filesRoot` holds the same absolute root that
[`GET /files`](#get-files) reports, so a client can place a session `cwd` without a listing. See
[Capabilities](/api/system#capabilities).

**On by default.** The routes are on for every install, with the root `~/projects`, and need no configuration. To
switch them off, set `gateway.files.enabled` to `false` and restart. Only a boolean counts: the string `"false"`, `0`
or `null` is ignored with a warning in `gateway.log`, and the files API keeps its default, which is on:

```json
{ "gateway": { "files": { "enabled": false } } }
```

**Security model.** An admin key can do everything, for every agent. Any other key reaches the agents it lists, can
write only when it has `write: true`, and can list every folder under the root and read its git status. The gateway
does not serve file contents to any key. Every listing carries the host path of the root as `root`, which usually
includes the home directory. These checks are not a filesystem boundary. Agents run with
`--dangerously-skip-permissions`, and a chat bound to a folder runs its agent inside it, so any key that can send that
agent a message can ask it to read or change any file the gateway's user can reach. Sending a message does not need
`write`, so this includes a read-only key. Treat an admin key as full access to the pod, and treat a key that can reach
an agent as able to change every folder under the root.

## Configuration {#configuration}

```json
{
  "gateway": {
    "files": { "root": "/srv/projects", "trusted": ["site"], "enabled": true }
  }
}
```

| Key | Meaning |
|-----|---------|
| `root` | An absolute path or a path starting with `~/`. Default `~/projects`. |
| `trusted` | Paths of folders relative to the root, such as `site` or `site/web`, whose own `.claude/` settings, hooks, `.mcp.json` and `CLAUDE.md` load in a chat bound to exactly that folder. A subfolder of a trusted folder is not trusted. Each entry must pass the [path rules](#paths), and an invalid entry stops the config from loading. Default empty. See [Sessions](/api/sessions#post-apiv1agentsagentidsessions). |
| `enabled` | `false` leaves the files and git routes unmounted and refuses folder-bound chats. Default `true`. |

Changing any of them takes effect after a gateway restart. Other keys inside `gateway.files` are ignored, and the
gateway logs a warning that names them.

**The old key.** `gateway.projects` was renamed to `gateway.files`. A `config.json` that still holds
`gateway.projects` fails to load with `gateway.projects was renamed to gateway.files; move its root, trusted and
enabled keys there`. Move the block by hand: the gateway reads no alias.

**Safety checks on the root.** The gateway trims the root and strips trailing slashes before it checks and uses it,
so `" ~/projects/ "` and `~/projects` are one root.

- The root must not be `/`, your home directory, `~/.claude-gateway`, the directory holding `config.json`, or any
  directory that contains one of them. The check follows symlinks. A root set in `config.json` that breaks this rule
  stops the gateway from loading.
- A root spelled like the default (`config.template.json` ships `"~/projects"`) counts as unset. When the default
  breaks the rule above, for example because `~/projects` is a symlink to HOME, the gateway logs a warning and sets
  `enabled` to `false` instead of refusing to start.
- A root that holds `:`, or that resolves through a symlink to a path holding `:`, is not supported, because git's
  discovery fence is a `:`-separated list. The gateway logs a warning and sets `enabled` to `false`.

**Requirements and files on disk.** The git routes need `git` 2.26 or newer (see [Git](/api/git#requirements)). The
gateway writes these files:

| Path | Holds |
| ---- | ----- |
| `<agent dir>/sessions/api-<chatId>/index.json` | The session index. A folder-bound chat's entry holds its folder as `cwd` |
| `<parent>/.deleting-<name>-<id>` | What a `DELETE` could not remove. Safe to delete by hand |

## Paths {#paths}

Each folder name in a path matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. So no segment can be `.`, `..`, empty, or
start with a dot or a dash, and the hidden `.deleting-*` folders a failed delete leaves are out of reach. A path has
at most 32 segments, no leading or trailing `/`, and no `//`.

The gateway resolves every path through symlinks with `realpath`, and refuses one whose real location is outside the
root (`403 path_escape`). A link inside the root that points back at the root itself, such as `all -> .`, is refused
the same way, so no entry can span every other one.

## Errors {#errors}

Every error has the shape `{ "error": string, "code": string }`. Branch on `code`; `error` is human-readable and may
change. Some git errors add fields. This one table covers every files and git route. A request without a valid key
gets the gateway's usual `401` or `403` before it reaches these routes.

| Status | `code` | When |
|--------|--------|------|
| 400 | `invalid_path` | `path` is not a string, is absolute, has an empty segment, has more than 32 segments, or names the root where a folder is required (mkdir, delete, git status, busy, marks). |
| 400 | `invalid_name` | A segment of `path` fails the [name rule](#paths). |
| 400 | `not_a_directory` | The path names a file, a link to a file, or the root exists but is not a directory. |
| 400 | `confirm_mismatch` | `DELETE` did not send `confirm` equal to the last segment of `path`. |
| 400 | `invalid_mark` | `POST /files/busy` did not send 1 to 200 `paths`, or `POST /files/marks` did not send `purpose` `cleaning` or `starting` and an integer `ttlSec` from 60 to 300. |
| 400 | `invalid_cleanup` | `POST /files/cleanup` did not send 1 to 200 `items`, each an object with a `project` and a `folder`. |
| 403 | `path_escape` | The real path (after symlinks) leaves the root, or is the root itself. |
| 403 | `permission_denied` | The gateway's user cannot read or change it. |
| 403 | `forbidden_key` | mkdir, delete, busy or marks with a key that is not an admin key. |
| 404 | `not_found` | The folder, or the parent of a new folder, does not exist. |
| 409 | `already_exists` | mkdir named a folder, file or symlink that already exists, compared case-insensitively (`Site` collides with `site`). |
| 409 | `symlink_in_path` | `DELETE` or mkdir of a nested path whose parent folders include a symbolic link. |
| 409 | `cross_device` | `DELETE` of a folder on another filesystem than its parent, or one that holds a mount point. |
| 409 | `in_use` | `DELETE` or `POST /files/marks` found a chat or task working in the folder, in a folder inside it, or in a folder holding it. A mark answer adds `reasons`. |
| 409 | `deleting` | The folder, a folder inside it, or a folder holding it is being deleted by another request. mkdir answers it for a new folder inside one being deleted. |
| 409 | `marked` | A [mark](#marks) holds the folder, a folder inside it, or a folder holding it. `DELETE`, `POST /files/marks` and mkdir (for a new folder inside a marked one) answer it. |
| 409 | `not_a_git_repo` | Git status of a folder that is not a repository. |
| 409 | `git_unsafe_owner` | The repository belongs to another user and git refuses it. |
| 409 | `git_unreadable` | The folder has a `.git` that git cannot read safely. |
| 429 | `too_many_marks` | `POST /files/marks` when the gateway already holds 512 unexpired marks. |
| 500 | `git_failed` | Any other git failure. Git's output is not returned. |
| 500 | `internal` | Any other filesystem error, or an unexpected failure inside the gateway. The body is `{ "error": "Internal error", "code": "internal" }` and the gateway logs only the error's class and errno code. |
| 503 | `git_unavailable` | Git is not installed, or is not on the gateway's `PATH`. |
| 504 | `timeout` | Git ran past its limit of 3 seconds. |

The JSON Schemas of every request and response, and golden fixtures recorded from a real gateway, are in
`contracts/files-git/` of the gateway repository. `npm run contracts:fixtures` records them again.

## GET /api/v1/files {#get-files}

List the folders directly under `path`, sorted by name. Only directories, and symlinks that resolve to a directory
inside the root, are listed. Files are left out. When the root does not exist, a listing of the root has
`exists: false`, and the gateway does not create it. A missing folder under an existing root is `404 not_found`.

| Query | Required | Description |
|-------|----------|-------------|
| `path` | No | The folder to list. Absent or empty lists the root. |

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:10850/api/v1/files?path=site"
```

```json
{
  "root": "/home/user/projects",
  "exists": true,
  "path": "site",
  "abs": "/home/user/projects/site",
  "entries": [
    { "name": "web", "path": "site/web", "abs": "/home/user/projects/site/web", "type": "dir", "modified_at": "2026-10-06T07:41:58.706Z", "is_git": true }
  ]
}
```

`root` is the root resolved through symlinks, or the configured spelling when it does not exist. `abs` of the listing
is the listed folder's real path, and each entry's `abs` is that joined with the entry's name. `type` is always `"dir"`
today; a later release may add other types. `is_git` is true when the folder has a `.git` entry (a directory, or the
file a worktree or submodule uses).

Folders the list leaves out are reported in two optional arrays, so a client can tell the user why a folder is
missing. Both are absent when empty.

- `skipped` holds `{ "name", "reason" }` for each folder or link that is not listed, sorted by name, at most 50.
  `reason` is `invalid_name` (the [name rule](#paths) rejects it), `symlink_outside_root` (a link whose target is
  outside the root, or is the root itself) or `not_a_directory` (a link to a file). Loose files and broken links are
  not reported.
- `leftovers` holds the names of hidden `.deleting-*` folders in the listed folder, sorted, at most 50. They are what a
  [`DELETE`](#delete-files) could not remove. The gateway never sweeps them.

## POST /api/v1/files/mkdir {#post-files-mkdir}

Create exactly one new folder. Its parent must already exist under the root, except that a missing root is created
first. Needs an admin key. Returns `201` with the new folder as `entry`, in the shape [the list](#get-files) uses.

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | The new folder, such as `site` or `site/web`. |
| `git_init` | No | When `true`, run `git init -q` in the new folder (10 second timeout). Any other value is ignored. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"path":"demo","git_init":true}' http://localhost:10850/api/v1/files/mkdir
```

```json
{ "entry": { "name": "demo", "path": "demo", "abs": "/home/user/projects/demo", "type": "dir", "modified_at": "2026-10-06T07:41:58.686Z", "is_git": true } }
```

If the name is taken, compared case-insensitively within the parent, the response is `409 already_exists` and the
existing entry is not touched. Creates in one parent run one at a time, and the create is an atomic `mkdir`, so of
several concurrent requests for one name exactly one gets `201`. A missing parent is `404 not_found`, and nothing is
created above the new folder. A parent reached through a symbolic link is `409 symlink_in_path`, as for
[`DELETE`](#delete-files), so a folder never appears under two names. A new folder inside one a [mark](#marks) holds is
`409 marked`, and inside one a `DELETE` is removing is `409 deleting`. If `git init` fails, the folder is kept and the response is still `201`, with a
`warning` that names only the exit code, the signal, or the spawn error (such as `ENOENT` when git is not installed).
Git's output goes to the gateway log, never to the client.

```json
{
  "entry": { "name": "nogit", "path": "nogit", "abs": "/home/user/projects/nogit", "type": "dir", "modified_at": "2026-10-06T07:41:58.698Z", "is_git": false },
  "warning": "git init failed (ENOENT)"
}
```

## DELETE /api/v1/files {#delete-files}

Delete the folder `path` names and everything in it. Needs an admin key. Returns `200` with `{ "path": "<path>" }`.
This cannot be undone, and the gateway keeps no copy. The request has a JSON body.

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | The folder to delete. The root itself is refused with `400 invalid_path`. |
| `confirm` | Yes | The last segment of `path`, exactly: `web` for `site/web`. Anything else is `400 confirm_mismatch`. |

```bash
curl -X DELETE -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"path":"site/node_modules","confirm":"node_modules"}' http://localhost:10850/api/v1/files
```

**What it refuses.**

- A path whose real location leaves the root, or is the root (`403 path_escape`).
- A nested path whose parent folders include a symbolic link (`409 symlink_in_path`). Only the last segment may be a
  link.
- A folder on another filesystem than its parent, or one that holds a mount point (`409 cross_device`). A delete never
  reaches into another filesystem.
- A folder in which a chat turn is in flight, a session is still starting, an accepted message is not yet handled, or
  an orchestrated task has not finished, and a folder that holds or sits inside such a folder (`409 in_use`). Deleting
  the chat session does not release it while its turn, message or task is still live.
- A folder that is, holds or sits inside one another `DELETE` is removing (`409 deleting`). While a delete runs, a
  message or task in a chat bound to a folder that overlaps it the same way fails with `409 CWD_UNAVAILABLE`, and a new
  session with that `cwd` fails with `409 cwd_unavailable` (`reason` `deleting`).
- A folder that is, holds or sits inside one a [mark](#marks) holds (`409 marked`).

The gateway does not check for other processes, such as a dev server, that run inside the folder: stop them before
you delete.

**How it removes.** A path whose last segment is a symlink loses only the link, never what it points to. Otherwise
the folder is first renamed to a hidden sibling `.deleting-<name>-<id>`, so it leaves every listing in one step and its
name is free at once. Links inside the folder are removed, never followed. If some files cannot be removed, for
example a subfolder without write permission, the response is still `200` and adds a `warning` naming the folder to
remove by hand (`rm -rf <parent>/.deleting-<name>-<id>`). The folder is also listed in `leftovers` of
[the list](#get-files) of its parent. A folder is never left listed with part of its files gone. Chats bound to a
deleted folder are kept, and their folder no longer resolves.

## Cleanup {#cleanup}

The gateway decides which folders a cleaner may remove. A caller chooses among them and nothing else is removed.

| Folder | Cleanable when |
| ------ | -------------- |
| `node_modules` | The project's top holds `package.json`. |
| `.venv` | A requirements, `pyproject.toml`, Pipfile, `poetry.lock`, `uv.lock` or `setup.py` file sits at the project's top, and `pyvenv.cfg` sits inside the folder. |
| `venv` | The same as `.venv`. |

A folder that is a link is never a candidate. The rules are the gateway's own and change only with a gateway release.

### GET /api/v1/files/cleanup/candidates {#get-files-cleanup-candidates}

Admin key only, like every cleanup route. Answers `{ "candidates": [{ "project": "app", "folder": "node_modules" }] }`, every candidate directly under every project in the root. It reads only and names no sizes.

### POST /api/v1/files/cleanup {#post-files-cleanup}

Admin key only. Body: `{ "items": [{ "project": "app", "folder": "node_modules" }] }`, 1 to 200 items. Each item is handled on its own, in order, and the answer is `200` with `{ "results": [...] }`, one entry per item with `project`, `folder`, `state` and, unless removed, `code`:

| `state` | `code` | Meaning |
| ------- | ------ | ------- |
| `removed` | | The folder is gone. |
| `skipped` | `in_use`, `marked`, `deleting` | A chat, task or mark holds the folder. Nothing was removed. |
| `failed` | `not_a_candidate` | The folder is not on the list above right now, or the `folder` is not one of the three names. |
| `failed` | `not_found` | The `project` folder does not exist. |
| `failed` | `invalid_name` | The `project` name fails the [name rule](#paths), so `..` is refused. |
| `failed` | another error | The same code the delete route answers, such as `symlink_in_path`. |

A removal keeps every guard of `DELETE /files`: it stops at a link on the way, a mount point, and any hold.

## Busy checks and marks {#marks}

A cleaner, such as a job that removes a folder or the build output inside it, must not work in a folder while a chat
or task runs there. The marks routes let it check which folders are in use and then hold one while it works. All three
routes need an admin key, and `capabilities.files` lists `"marks"` when the gateway serves them. Paths follow the
[path rules](#paths), and the root itself is refused with `400 invalid_path`.

### POST /api/v1/files/busy {#post-files-busy}

Report what is working in each folder right now. The answer is advisory. Work can start the moment it is sent. To act
on a folder, take a mark instead.

| Field | Required | Description |
|-------|----------|-------------|
| `paths` | Yes | An array of 1 to 200 paths, none of them the root. Any other count is `400 invalid_mark`. A path that fails the path rules fails the whole request with `400 invalid_path` or `400 invalid_name`. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"paths":["site","gone"]}' http://localhost:10850/api/v1/files/busy
```

```json
{
  "results": [
    { "path": "site", "abs": "/home/user/projects/site", "busy": true, "reasons": ["turn"] },
    { "path": "gone", "abs": null, "busy": false, "reasons": [], "error": "not_found" }
  ]
}
```

The response is `200` with one result per path, in request order. `abs` is the folder's real path. `reasons` lists
what works in the folder, in a folder inside it, or in a folder holding it:

| Reason | Meaning |
|--------|---------|
| `turn` | A chat turn runs or is queued. |
| `spawn` | A session process is starting. |
| `task` | An orchestrated task has not finished. |
| `session` | An idle session process still runs in the folder. It is reported, but it does not make `busy` true. |
| `marked` | A mark holds the folder. |
| `deleting` | A `DELETE` is removing the folder. |

`busy` is `true` when `reasons` holds anything other than `session`. A path that does not resolve has `abs: null`,
`busy: false`, `reasons: []`, and `error` set to its [error code](#errors), such as `not_found` or `path_escape`.

### POST /api/v1/files/marks {#post-files-marks}

Hold a folder while a cleaner works in it. Returns `201` with the mark.

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | The folder to hold. The root is refused with `400 invalid_path`. |
| `purpose` | Yes | `cleaning` or `starting`. |
| `ttlSec` | Yes | An integer from 60 to 300. The mark expires on its own after this many seconds. |

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"path":"site/web","purpose":"cleaning","ttlSec":120}' http://localhost:10850/api/v1/files/marks
```

```json
{ "markId": "3f6c2a8e-5d0b-4c47-9a71-2b8e4f1d6c90", "path": "site/web", "abs": "/home/user/projects/site/web", "purpose": "cleaning", "expiresAt": "2026-10-21T08:02:00.000Z" }
```

The gateway checks for other holds, checks for work in the folder, and adds the mark in one synchronous step in the
gateway process. No chat turn, spawn or task can start in the folder between the check and the mark. The request fails
with these codes:

| Status | `code` | When |
|--------|--------|------|
| `400` | `invalid_mark` | `purpose` or `ttlSec` is missing or out of range. |
| `400` | `invalid_path`, `invalid_name` | `path` fails the [path rules](#paths) or names the root. |
| `403` | `path_escape` | The real path leaves the root, or is the root itself. |
| `403` | `forbidden_key` | The key is not an admin key. |
| `400` | `not_a_directory` | `path` names a file, or a link to a file. |
| `404` | `not_found` | The folder does not exist. |
| `409` | `in_use` | A turn, spawn or task works in the folder, in a folder inside it, or in a folder holding it. `reasons` lists them, as in the [busy check](#post-files-busy). An idle session process does not block a mark. |
| `409` | `marked` | Another mark holds the folder, a folder inside it, or a folder holding it. |
| `409` | `deleting` | A `DELETE` is removing the folder, a folder inside it, or a folder holding it. |
| `429` | `too_many_marks` | The gateway already holds 512 unexpired marks. Release one, or wait for one to expire. |

While a mark is held, these requests fail for the marked folder, for any folder inside it, and for any folder that
holds it:

- [Session create](/api/sessions#post-apiv1agentsagentidsessions) with that `cwd` answers `409 path_marked`.
- A chat turn or a session spawn in such a folder fails with `409 PATH_MARKED`.
- An orchestrated task fails to queue or start with `PATH_MARKED`.
- A streaming turn (`"stream": true`) answers `200` and sends an SSE `error` frame with code `PATH_MARKED`.
- [`DELETE /files`](#delete-files) answers `409 marked`.
- Another `POST /files/marks` answers `409 marked`.
- [mkdir](#post-files-mkdir) of a new folder inside the marked folder answers `409 marked`. A new folder beside it, in
  the folder that holds it, is allowed.

The mark is kept on the folder's real path, so a symlink that leads to the folder is held too.

**Known limitation.** A mark sees only work the gateway starts: chat turns, starting session processes and
orchestrated tasks. An idle session process does not make a folder busy, so it neither fails a mark nor shows `busy`.
Processes the gateway did not start, such as a dev server or another listener in the folder, are not seen at all until
the gateway tracks processes. Stop them yourself before you clean.

Marks live in the gateway's memory only. A gateway restart drops every mark, so a cleaner that must survive a restart
takes its mark again. An expired mark is removed lazily, the next time a request checks holds, and it holds nothing
after `expiresAt` either way.

### DELETE /api/v1/files/marks/:markId {#delete-files-marks}

Release a mark. Always returns `204`. An unknown, released or expired `markId` is not an error, so a retry is safe.

A mark also expires on its own at `expiresAt`. A cleaner that crashes frees the folder when its mark expires.

### Clean a folder safely

1. Take a mark on the folder with `POST /files/marks`. On `409`, stop and try again later.
2. Remove what you need to remove, directly on disk. Finish before `expiresAt`. `DELETE /files` refuses a folder
   that any mark holds, your own mark included.
3. Release the mark with `DELETE /files/marks/:markId` in a `finally` block, so it is released when step 2 fails.
