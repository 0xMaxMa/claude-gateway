# Files API {#files-api}

The gateway lists, creates, and deletes folders under `gateway.files.root` (default `~/projects`). It does not serve file contents. Any valid API key may list; create and delete require an admin key. `GET /api/v1/capabilities` advertises `files: ["list", "create", "delete"]` for an admin key, or `files: ["list"]` for other keys. The same root serves the [Git API](/api/git).

## Configuration {#configuration}

`gateway.files.root` must be an absolute path or begin with `~/`. It cannot be or contain HOME, the gateway state directory, or the directory containing `config.json`. A root containing `:` disables this API because git's discovery fence cannot express it. `gateway.files.enabled: false` disables files, git, processes, and folder-bound sessions. `gateway.files.trusted` lists exact root-relative folders whose own Claude settings may load in a session. Changes require a restart.

## Paths {#paths}

Paths are relative to the files root and have at most 32 segments. Ordinary names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. `DELETE /files` also accepts dot-prefixed names such as `.venv`, so clients can remove hidden folders. `GET /files?include_hidden=true` includes those folders in a listing and permits them in the `path` query. `.` and `..` and every `.deleting-*` trash folder are refused. The gateway resolves paths against the real root and refuses escapes or symlinked parent folders for mutations.

## Errors {#errors}

Errors have `{ "error": string, "code": string }`. Git errors may include additional fields.

| Status | `code` | Meaning |
|--------|--------|---------|
| 400 | `invalid_path` | path must be a relative path of entry names joined by / |
| 400 | `invalid_name` | A path segment is not a valid entry name |
| 400 | `not_a_directory` | Not a directory |
| 400 | `confirm_mismatch` | confirm must equal the last segment of path |
| 403 | `path_escape` | Path resolves outside the files root |
| 403 | `permission_denied` | Permission denied |
| 403 | `forbidden_key` | Admin API key required |
| 404 | `not_found` | Not found |
| 409 | `already_exists` | An entry with this name already exists |
| 409 | `symlink_in_path` | A folder above the entry is a symbolic link |
| 409 | `cross_device` | The entry is on another filesystem or holds a mount point |
| 409 | `in_use` | A chat or task is working in this folder |
| 409 | `deleting` | The folder is being deleted |
| 409 | `not_a_git_repo` | The folder is not a git repository |
| 409 | `git_unsafe_owner` | Git refuses this repository because another user owns it. Run `git config --global --add safe.directory <path>` as the gateway's user, or fix the owner. |
| 409 | `git_unreadable` | This is a git repository the gateway cannot read safely: check its permissions, its config, and any filter drivers it defines |
| 500 | `internal` | Internal error |
| 500 | `git_failed` | Git failed |
| 503 | `git_unavailable` | Git is not installed on this machine, or is not on the gateway's PATH |
| 504 | `timeout` | Git took too long |

## GET /api/v1/files {#get-files}

List direct child folders. `?path=<relative-folder>` chooses a parent; no path lists the root. `?include_hidden=true` also lists valid dot-prefixed folders, except delete trash; it defaults to `false`. The response contains `root`, `exists`, `path`, `abs`, and `entries`. Each entry includes `name`, `path`, `abs`, `type`, `modified_at`, `is_git`, and `size` in bytes or `null` if size measurement times out. Invalid or unsafe entries appear in `skipped`; hidden trash appears in `leftovers`.

## POST /api/v1/files/mkdir {#post-files-mkdir}

Admin only. Body: `{ "path": "site/web", "git_init": true }`. Creates one folder under an existing real parent and returns `201` with `entry`. `git_init` is optional. A failed git initialization leaves the folder and adds a `warning`.

## DELETE /api/v1/files {#delete-files}

Admin only. Body: `{ "path": "site/.venv", "confirm": ".venv" }`. `confirm` must equal the final path segment. The root itself cannot be deleted. A live chat or task in or around the folder returns `409 in_use`; an overlapping delete returns `409 deleting`. Symlinked parents and cross-device trees are refused. The final symlink is unlinked without following it. The folder is atomically renamed to hidden `.deleting-*` trash before recursive removal; a partial removal adds a warning and leaves the trash path in `leftovers`.
