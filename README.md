# codex-session-sync

[中文文档](./README_CN.md)

Sync, back up, and manage local [OpenAI Codex](https://github.com/openai/codex) sessions across machines — via any WebDAV server, with a CLI and a local Web GUI.

## Why

Codex (CLI / Desktop / IDE extension) keeps all conversation state in a local `~/.codex` directory. If you work on more than one machine, your sessions don't follow you. codex-session-sync moves them safely:

- **Cold sync** — only runs when Codex is closed, so state files are never corrupted mid-write
- **Backup before overwrite** — every destructive step snapshots first
- **Local-first** — your data goes only to the WebDAV server you configure; no third-party service, no telemetry

## Features

| Feature | Description |
|---------|-------------|
| WebDAV sync | Bidirectional sync of sessions / skills / plugins with Nextcloud, Synology, Koofr, or any WebDAV server |
| Incremental sync | File-level incremental updates by default, with one-time content checks when a new device joins an existing repository |
| Web GUI | Dashboard, session browser, sync progress (SSE live stream), backup management — at `http://localhost:7420` |
| Session management | Browse by project, search, rename (syncs back into Codex's own UI), delete (cleans all three Codex stores) |
| Provider merge | Merge sessions isolated between ChatGPT web login (`openai`) and API-key login (`custom`) into one visible list |
| Backup & restore | Timestamped snapshots, one-click restore, retention pruning, delete |
| Conflict policies | `manual_abort` / `prefer_local` / `prefer_cloud` / `prefer_newer_mtime` |
| Safety guards | Codex process detection, atomic writes (tmp + rename), path-traversal protection, pre-merge/pre-restore auto-backup |

## Requirements

- Node.js **≥ 22.5** (uses the built-in `node:sqlite` module)
- Codex CLI or Codex Desktop installed (a `~/.codex` directory exists)
- Windows / macOS / Linux (Windows is the most battle-tested)

## Installation

```bash
npm install -g codex-session-sync
```

This gives you the `cxsync` command. Or run without installing:

```bash
npx codex-session-sync
```

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/shonngithub/codex-session-sync.git
cd codex-session-sync
npm install
npm install -g .
```

</details>

To create a portable package for installation on other machines:

```bash
npm install
npm test
npm pack --dry-run       # inspect package contents
npm pack                 # creates codex-session-sync-<version>.tgz
npm install -g ./codex-session-sync-<version>.tgz
```

To publish to the npm registry:

```bash
npm login
npm version patch        # npm versions must be unique
npm publish --access public
```

The `prepublishOnly` hook runs `npm test` before publishing. After publication,
other machines can use `npm install -g codex-session-sync` or
`npx codex-session-sync`.

## Quick start

```bash
# 1. Generate config at ~/.codex-session-sync/config.yml
cxsync init-config

# 2. Edit the config — fill in your WebDAV credentials
#    webdav:
#      url: https://your-server/remote.php/dav/files/username
#      username: your_username
#      password: your_password
#      remote_path: /codex-sync

# 3. Check everything is ready
cxsync doctor

# 4. Start the Web GUI (opens browser automatically)
cxsync            # same as `cxsync serve`
```

Or go CLI-only:

```bash
cxsync push --dry-run   # preview local -> WebDAV
cxsync push             # upload (close Codex first)
cxsync pull --dry-run   # preview WebDAV -> local
cxsync pull             # download (close Codex first)
# Generic form: cxsync sync --direction push --apply
```

## CLI reference

```
cxsync init-config [--output <path>] [--force]     Generate config file
cxsync validate                                    Validate config
cxsync doctor                                      Preflight diagnostics
cxsync plan                                        Show sync plan (read-only)
cxsync push [--dry-run]                            Local -> WebDAV (applies by default)
cxsync pull [--dry-run]                            WebDAV -> local (applies by default)
cxsync sync --direction <direction> --dry-run      Generic sync entry point
cxsync restore [--from <snapshot>] --apply         Restore from backup
cxsync sessions [--project <name>]                 List local sessions
cxsync merge-providers --list                      Show sessions per login provider
cxsync merge-providers --from openai --to custom --apply   Merge providers
cxsync serve [--port 7420] [--no-open]             Start Web GUI (default — plain `cxsync` works too)
```

Global flags: `-c <config path>`, `-v` (verbose).

Exit codes: `3` = Codex is running (close it first).

## Typical workflow: machine A → machine B

```bash
# On machine A: close Codex, then upload
cxsync push

# Wait for your WebDAV/cloud server to settle

# On machine B: close Codex, then download
cxsync pull

# List IDs and resume the same session instead of starting a new one
cxsync sessions
codex resume --all <SESSION_ID>
```

`sessions/**` contains the conversation context and `session_index.jsonl` is the
resume index. `cxsync sessions` prints copyable IDs; after pulling, use `codex resume --all <SESSION_ID>`. Launching plain
`codex` starts a new conversation. Rollouts keep the absolute `cwd` from the
source device, so keep project directories consistent when possible. Otherwise
use `codex resume --all` to list sessions across working directories and open the matching project directory on the target device. Source
code, dependencies, and login state are outside this tool's sync scope.

Sync is file-level incremental by default. The local manifest stores this
device's history. On a new device, existing remote files are content-checked
once so different filesystem mtimes cannot silently overwrite a session. After
a successful run, the local manifest records the last observed metadata for
each relative path and is updated atomically. The same observations are kept on
the WebDAV server as the internal
`.cxsync-manifest.json` file under `webdav.remote_path`; it is retained on the
remote and excluded from the user file plan.

The sync direction controls which side is authoritative:

| Direction | Behavior |
|-----------|----------|
| `bidirectional` | Propagate changes from either side; changes on both sides follow the configured conflict policy |
| `push` | Treat local files as the source and upload local changes; remote-only files are left untouched |
| `pull` | Treat remote files as the source and download remote versions; matching local files are overwritten after a `.bak` copy |

## Web GUI

| Page | What it does |
|------|--------------|
| Dashboard | Codex process status, session stats, quick actions |
| Sessions | Browse by project, search, double-click rename, delete |
| Sync | WebDAV connection test, plan preview, live progress + log stream |
| Backup | Snapshot list with storage path, create/restore/delete, provider merge |

## How Codex stores sessions (what this tool touches)

| Store | Purpose |
|-------|---------|
| `sessions/YYYY/MM/DD/rollout-*.jsonl` | Conversation content (JSONL, first line is `session_meta`) |
| `session_index.jsonl` | Index used by `codex resume` |
| `state_5.sqlite` → `threads` | Desktop's local index (absolute paths and login metadata; not overwritten across devices) |

Rename writes stores 2+3 (auto-creating missing index entries). Delete cleans all three. Provider merge rewrites `model_provider` in stores 1+3.

## Configuration

See [`config.example.yml`](./config.example.yml) for the full annotated config. Key options:

| Key | Default | Description |
|-----|---------|-------------|
| `manifest_path` | `~/.codex-session-sync/manifest.json` | Local file-level sync baseline; keep it outside `codex_home` |
| `sync.direction` | `bidirectional` | `bidirectional` / `push` / `pull` |
| `sync.session_mode` | `all` | Sync all date folders so older sessions remain resumable |
| `sync.compare` | `mtime` | `mtime` or `mtime_hash_fallback` (SHA-256 tiebreak) |
| `conflict.policy` | `manual_abort` | Conflict resolution strategy |
| `backup.compression` | `none` | `none` (directory) or `zip` |
| `backup.retention_days` | `30` | Auto-prune old snapshots |
| `server.port` | `7420` | Web GUI port (binds 127.0.0.1 only) |

## REST API

The Web GUI is backed by a documented REST API (`docs/API.md`) — sessions, sync plan/apply (SSE), backups, provider merge, WebDAV test. Integrate it into your own tooling if you like.

## Development

```bash
npm test        # unit + e2e tests (e2e runs against an in-memory WebDAV server)
npm run dev     # start GUI server on :7420
```

Project layout: see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Security notes

- Sync/delete/merge refuse to run while Codex is running (process detection, sqlite lock safety)
- Every overwrite/merge/restore is preceded by an automatic snapshot
- WebDAV credentials live only in your local `config.yml` (never uploaded)
- The GUI server binds to `127.0.0.1` — not reachable from the network
- `auth.json`, tokens, API keys, and Desktop `state_5.sqlite` are not synchronized; use CLI `codex resume` for cross-device handoff
- The WebDAV root is allowlisted to `sessions/**`, `session_index.jsonl`, `skills/**`, and `plugins/**`; other files are ignored

## Acknowledgements

Design informed by [codexSync](https://github.com/kroxiksut/codexSync) (cold-sync handoff, backup-before-overwrite) and codex-session-toolkit variants (web UI session browsing, rename write-back).

## License

MIT
