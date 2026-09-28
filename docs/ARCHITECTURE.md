# codex-session-sync — Architecture

## Module tree

```
bin/
  cxsync.js              CLI entry point (Commander)
src/
  config.js              Load & validate config.yml
  scanner.js             Walk ~/.codex, parse session_index.jsonl
  session-integrity.js   Read-only index/rollout consistency checks
  webdav-client.js       webdav npm wrapper (list/stat/get/put/mkdir)
  manifest.js            Read/write versioned file-level sync manifest
  sync-service.js        Shared incremental scan/plan/apply workflow
  sync-engine.js         Build plan, resolve conflicts, apply (copy/skip/abort)
  backup.js              Snapshot creation & restore, zip support
  process-check.js       Detect codex.exe / codex process, optional terminate
  logger.js              Structured logger (text/json), daily rotation
  server.js              Express HTTP server + SSE bus
  api/
    sessions.js          GET /api/sessions, GET /api/sessions/:id
    sync.js              POST /api/sync/plan, POST /api/sync/apply (SSE)
    backup.js            GET /api/backups, POST /api/restore
    webdav.js            GET|POST /api/config/webdav (test connection)
    config.js            GET|PUT /api/config
web/
  index.html             Single-file SPA (no build step)
test/
  sync-engine.test.js
  manifest.test.js
  session-integrity.test.js
  sync-service.test.js
  e2e-webdav.test.js
  backup.test.js
  scanner.test.js
docs/
  API.md                 REST contract
  ARCHITECTURE.md        This file
```

## Data flow

```
~/.codex  →  scanner  →  plan(sync-engine)  →  apply
                               ↑                  ↓
                  local manifest / remote manifest  sync-service
                                                        ↓
                                               webdav-client / fs
                  (last successful baseline)             ↓
                                                   backup (before overwrite)
```

## Incremental sync and manifests

The sync engine compares files by relative path. Incremental mode is the
default: a versioned manifest records the last successful observation on both
sides (`local` and `remote` metadata for each path), so a change on one side
can be propagated without re-copying unchanged files. When both sides changed
the same path, the normal conflict policy applies.

The local manifest defaults to `~/.codex-session-sync/manifest.json` and can be
relocated with `manifest_path`. The remote copy is always
`webdav.remote_path/.cxsync-manifest.json`. This remote file is internal state:
it is retained on the server and excluded from the user file set and sync
plan.

When a device has no local manifest, the first run compares the current file
sets directly. Existing remote files are hashed once so mtimes from another
device cannot silently decide an overwrite. A successful apply writes the new
observations to the remote manifest and atomically replaces the local manifest;
failed or aborted applies leave the previous local baseline intact.

`sync.direction` sets the authoritative side. `bidirectional` propagates
changes from either side and exposes simultaneous changes as conflicts;
`push` plans local-to-remote updates and leaves remote-only files untouched;
`pull` plans remote-to-local updates and overwrites matching local files after
the normal local backup step. The shared plan intentionally excludes
`state_5.sqlite`: Desktop's SQLite contains absolute rollout paths and local
login metadata, so copying it between devices is not a safe merge strategy.
The remote file set is allowlisted to `sessions/**`, `session_index.jsonl`,
`skills/**`, and `plugins/**`, so credentials or unrelated files under the same
WebDAV directory are ignored.
The CLI can resume the portable `sessions/**` records directly.

## Config shape (config.yml)

```yaml
codex_home: ~/.codex          # local Codex state dir
machine_id: machine-a
manifest_path: ~/.codex-session-sync/manifest.json  # local incremental baseline
sync:
  mode: cold                  # cold only (Codex must be closed)
  direction: bidirectional    # bidirectional | push | pull
  compare: mtime              # mtime | mtime_hash_fallback
  time_tolerance_seconds: 2
  equal_mtime_action: skip    # skip | prefer_local | prefer_cloud | manual_abort
  delete_policy: never
  session_mode: all             # all sessions; date filtering is not implemented
conflict:
  policy: manual_abort        # manual_abort | prefer_cloud | prefer_local | prefer_newer_mtime
backup:
  enabled: true
  compression: none           # none | zip
  retention_days: 30
  max_backups: 0
webdav:
  url: https://example.com/dav
  username: user
  password: pass
  remote_path: /codex-sync
server:
  port: 7420
  open_browser: true
logging:
  level: INFO
  file: ~/.codex-session-sync/logs/sync.log
```
