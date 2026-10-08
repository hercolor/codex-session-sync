# codex-session-sync — Architecture

## Module tree

```
bin/
  cxsync.js              CLI entry point (Commander)
src/
  config.js              Load & validate config.yml
  scanner.js             Walk ~/.codex, parse session_index.jsonl
  claude-scanner.js      Select project sessions, memory, subagents and tool results under ~/.claude
  session-index.js       Merge Codex resume index by session ID
  session-integrity.js   Read-only index/rollout consistency checks
  webdav-client.js       webdav npm wrapper (list/stat/get/put/mkdir)
  manifest.js            Read/write versioned file-level sync manifest
  sync-service.js        Shared incremental scan/plan/apply workflow
  sync-engine.js         Build plan, resolve conflicts, apply (copy/skip/abort)
  backup.js              Snapshot creation & restore, zip support
  process-check.js       Detect Codex / Claude Code processes, optional Codex terminate
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
~/.codex / ~/.claude  →  selected scanner  →  plan(sync-engine)  →  apply
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

`session_index.jsonl` is the exception in bidirectional mode: it is merged by
session `id`, retaining entries added on either device. A duplicate ID uses the
newer valid `updated_at` record as a whole, with a stable canonical JSON
tie-breaker. Malformed rows and rows without a string ID stop the sync instead
of being silently discarded. One-way push and pull keep their selected side
authoritative for the index.

The local manifest defaults to `~/.codex-session-sync/manifest.json` and can be
relocated with `manifest_path`. The remote copy is always
`webdav.remote_path/.cxsync-manifest.json`. This remote file is internal state:
it is retained on the server and excluded from the user file set and sync
plan.

Selecting `claude` switches the local root to `claude_home` (default
`~/.claude`), the baseline to `claude_manifest_path` (default
`~/.codex-session-sync/claude-manifest.json`), and the WebDAV root to
`claude_remote_path` (default `<webdav.remote_path>-claude`). The credentials
are shared, but the repositories and manifests are independent. Claude's file
allowlist contains only `projects/<project>/<UUID>.jsonl`, project
`memory/**`, and `projects/<project>/<UUID>/{subagents,tool-results}/**`.
Credentials, settings, global history, and unrelated local state are excluded.
Only the selected client's process must be stopped before applying a sync.

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
claude_home: ~/.claude        # local Claude Code state dir
machine_id: machine-a
manifest_path: ~/.codex-session-sync/manifest.json  # local incremental baseline
claude_manifest_path: ~/.codex-session-sync/claude-manifest.json
claude_remote_path: /codex-sync-claude  # optional; derived if omitted
sync:
  mode: cold                  # the selected client must be closed
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
