# Processes API {#processes-api}

All three routes require an admin API key and `gateway.files` to be available. Paths are relative to `gateway.files.root`. The [capability manifest](/api/system#capabilities) advertises `processes: ["list", "start", "stop"]` to admin keys.

## GET /api/v1/processes {#get-processes}

With no query, returns `{ "processes": [{ "path": "site", "running": true, "listeners": [{ "port": 3001, "pids": [4242], "command": "node server.js", "address": "0.0.0.0" }] }] }`. `path` is the top-level folder under the root: a listener working in `site/web` is reported as `site`. Only folders with listeners appear.

`?path=site` instead returns one folder as `{ "path": "site", "running": true, "listeners": [...] }`. A folder with no listeners returns `running: false` and an empty `listeners` array.

## POST /api/v1/processes/start {#post-processes-start}

Body: `{ "path": "site", "script": ".pod/start.sh", "executable": "sh", "port": 3001 }`. `path` is the working folder; `script` is a regular file relative to it, with no symlink in its path. `executable` must be `sh` or `bash`. `port` is optional; when omitted, the gateway searches for a free unprivileged port. On success, returns `202 { "path": "site", "port": 3001, "pid": 4242, "running": true }`.

The started process receives only `PATH`, `HOME` (when set), `LANG`, and `PORT`. Scripts needing a login shell's `PATH` must set it themselves.

## POST /api/v1/processes/stop {#post-processes-stop}

Body: `{ "path": "site" }`. Returns `200 { "path": "site", "stopped": [{ "port": 3001, "pids": [4242] }], "remaining": [], "running": false }`. The gateway verifies process identity before signalling listeners in the folder.

## Errors {#errors}

Errors include `{ "code": "...", "error": "..." }` plus the fields noted below. Common path and authorization errors are listed in the [Files API](/api/files#errors).

| Status | Code | Additional fields / meaning |
| --- | --- | --- |
| 400 | `invalid_port` | Port must be an integer from 1024 to 65535. |
| 400 | `invalid_script` | Script path is invalid. |
| 400 | `invalid_executable` | Executable must be `sh` or `bash`. |
| 422 | `no_start_command` | Script is missing or is not a regular file. |
| 409 | `already_running` | `port` gives the existing listener port; `starting: true` instead means another start is in flight. |
| 409 | `port_in_use` | `port` gives the occupied requested port. |
| 409 | `no_free_port` | No port in the search range is available when `port` was omitted. |
| 502 | `start_failed` | `log` contains a masked tail of the process log. |
