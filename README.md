# codex-session-sync

[中文文档](./README_CN.md)

Sync local [OpenAI Codex](https://github.com/openai/codex) and Claude Code sessions across machines via WebDAV, with a CLI and a local Web GUI.

## Why

Codex and Claude Code keep conversations in local `~/.codex` and `~/.claude` directories. If you work on more than one machine, your sessions don't follow you. codex-session-sync moves them safely:

- **Cold sync** — write operations require the selected client to be closed
- **Backup before overwrite** — enabled by default for local and remote files
- **Local-first** — your data goes only to the WebDAV server you configure; no third-party service, no telemetry

## Features

| Feature | Description |
|---------|-------------|
| WebDAV sync | Bidirectional sync of sessions / skills / plugins with Nextcloud, Synology, Koofr, or any WebDAV server |
| Claude Code sync | Separate WebDAV repository for project conversations, their subagents/tool results, and project memory |
| Incremental sync | File-level incremental updates by default, with one-time content checks when a new device joins an existing repository |
| Web GUI | Dashboard, session browser, sync progress (SSE live stream), backup management — at `http://localhost:7420` |
| Session management | Browse by project, search, rename (syncs back into Codex's own UI), delete (cleans all three Codex stores) |
| Provider merge | Merge sessions isolated between ChatGPT web login (`openai`) and API-key login (`custom`) into one visible list |
| Codex backup & restore | Timestamped snapshots, one-click restore, retention pruning, delete |
| Conflict policies | `manual_abort` / `prefer_local` / `prefer_cloud` / `prefer_newer_mtime` |
| Safety guards | Codex process detection, atomic writes (tmp + rename), path-traversal protection, pre-merge/pre-restore auto-backup |

## Requirements

- Node.js **≥ 22.5** (uses the built-in `node:sqlite` module)
- Codex CLI / Desktop or Claude Code installed (the selected client's home directory exists on at least one device)
- Windows / macOS / Linux (Windows is the most battle-tested)

## Installation

```bash
npm install -g codex-session-sync-cli
```

This gives you the `cxsync` command. Or run without installing:

```bash
npx codex-session-sync-cli
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
npm pack                 # creates codex-session-sync-cli-<version>.tgz
npm install -g ./codex-session-sync-cli-<version>.tgz
```

To publish to the npm registry:

```bash
npm login
npm version patch        # npm versions must be unique
npm publish --access public
```

The `prepublishOnly` hook runs `npm test` before publishing. After publication,
other machines can use `npm install -g codex-session-sync-cli` or
`npx codex-session-sync-cli`.

## Quick start

You can also run `cxsync serve`, enter your WebDAV details on the Sync page,
and click Save configuration. This creates or updates
`~/.codex-session-sync/config.yml`, which CLI `push` / `pull` commands also
read. Testing the connection does not save settings. For a custom config,
run `cxsync -c /path/to/config.yml serve` and use the same `-c` path for CLI commands.

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

# Claude Code uses the same WebDAV credentials and its own repository.
cxsync push --client claude --dry-run
cxsync push --client claude       # close Claude Code first
cxsync pull --client claude       # close Claude Code first
```

## CLI reference

```
cxsync init-config [--output <path>] [--force]     Generate config file
cxsync validate                                    Validate config
cxsync doctor                                      Preflight diagnostics
cxsync plan [--client codex|claude]                Show sync plan (read-only)
cxsync push [--client codex|claude] [--dry-run]    Local -> WebDAV (applies by default)
cxsync pull [--client codex|claude] [--dry-run]    WebDAV -> local (applies by default)
cxsync sync --direction <direction> [--client codex|claude] --dry-run|--apply   Generic sync entry point
cxsync restore [--from <snapshot>] --apply         Restore from backup
cxsync sessions [--client codex|claude] [--project <name>]   List local session IDs
cxsync merge-providers --list                      Show sessions per login provider
cxsync merge-providers --from openai --to custom --apply   Merge providers
cxsync serve [--port 7420] [--no-open]             Start Web GUI (default — plain `cxsync` works too)
```

Global flags: `-c <config path>`, `-v` (verbose).

`--client` defaults to `codex` for sync commands. Exit code `3` means the
selected client is running (close it first).

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

## Claude Code handoff

Claude Code uses an independent WebDAV repository under
`<webdav.remote_path>-claude` by default (for example, `/codex-sync-claude`),
plus its own local `claude_manifest_path`. Set `claude_remote_path` to choose
another remote directory. Both clients use the same WebDAV credentials.

On NAS servers such as Synology, the WebDAV root lists shared folders;
creating a shared folder requires the NAS administration interface. Place
the sync repository inside an existing writable share. For example, with a
`Rclone` share, set `webdav.remote_path: /Rclone/codex-sync`; Claude then uses
`/Rclone/codex-sync-claude`. Use the same remote paths on both devices.

```bash
# On machine A, close Claude Code and upload.
cxsync push --client claude

# On machine B, close Claude Code and download.
cxsync pull --client claude
cxsync sessions --client claude
claude --resume <SESSION_ID>
```

`cxsync sessions --client claude` lists IDs from the synchronized `UUID.jsonl`
filenames. Only `~/.claude/projects/<project>/<UUID>.jsonl`, project `memory/**`, and
`<UUID>/subagents/**` and `<UUID>/tool-results/**` are included. The project
directory is derived from the local project path. `claude --continue` only
checks the current directory's recent sessions. Claude Code 2.1.223 or newer
can find a transferred session across local projects with
`claude --resume <SESSION_ID>`; on older versions, keep the same project path
or pass the downloaded transcript's absolute `.jsonl` path to `--resume`. Project source
files and dependencies still need their own synchronization. Claude credentials,
settings, global history, and other local state are excluded.

Sync is file-level incremental by default. Each client's local manifest stores this
device's history. On a new device, existing remote files are content-checked
once so different filesystem mtimes cannot silently overwrite a session. After
a successful run, the local manifest records the last observed metadata for
each relative path and is updated atomically. The same observations are kept on
the WebDAV server as the internal `.cxsync-manifest.json` file under that
client's remote directory; it is excluded from the user file plan.

The sync direction controls which side is authoritative:

| Direction | Behavior |
|-----------|----------|
| `bidirectional` | Propagate changes from either side; changes on both sides follow the configured conflict policy |
| `push` | Treat local files as the source and upload local changes; remote-only files are left untouched |
| `pull` | Treat remote files as the source and download remote versions; matching local files are overwritten after a `.bak` copy |

In bidirectional mode, `session_index.jsonl` is merged by session `id` so
entries added on either device are retained. If the same ID has different
records, the record with the newer `updated_at` wins as a whole; ties use a
stable rule. A malformed JSONL row or an entry without a string `id` stops the
sync with its line number so index content is not silently discarded. One-way
`push` and `pull` continue to propagate the index in the selected direction.

## Web GUI

| Page | What it does |
|------|--------------|
| Dashboard | Codex process status, session stats, quick actions |
| Sessions | Browse, rename, and delete Codex sessions only |
| Sync | Codex / Claude Code selector, WebDAV connection test, plan preview, live progress + log stream |
| Backup | Codex snapshot list with storage path, create/restore/delete, provider merge |

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
| `claude_home` | `~/.claude` | Claude Code local data directory |
| `claude_manifest_path` | `~/.codex-session-sync/claude-manifest.json` | Separate Claude Code incremental baseline |
| `claude_remote_path` | `<webdav.remote_path>-claude` | Separate Claude Code WebDAV directory; optional override |
| `sync.direction` | `bidirectional` | `bidirectional` / `push` / `pull` |
| `sync.session_mode` | `all` | Sync all Codex date folders so older sessions remain resumable |
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

- Sync refuses to run while the selected client is running; Codex delete/merge also check the Codex process
- With `backup.enabled`, sync keeps a `.bak` copy before replacing a local file and saves a remote copy before overwriting it; Codex provider merge creates a snapshot
- WebDAV credentials live only in your local `config.yml` (never uploaded)
- The GUI server binds to `127.0.0.1` — not reachable from the network
- `auth.json`, tokens, API keys, and Desktop `state_5.sqlite` are not synchronized; use CLI `codex resume` for cross-device handoff
- The WebDAV root is allowlisted to `sessions/**`, `session_index.jsonl`, `skills/**`, and `plugins/**`; other files are ignored
- The separate Claude Code repository is limited to project conversations, project memory, and session subagent/tool-result files; dedicated credentials, settings, global history, and other state files are ignored. Conversation and memory content may still contain secrets.

## Acknowledgements

Design informed by [codexSync](https://github.com/kroxiksut/codexSync) (cold-sync handoff, backup-before-overwrite) and codex-session-toolkit variants (web UI session browsing, rename write-back).

## License

MIT
