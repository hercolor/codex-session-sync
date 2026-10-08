# codex-session-sync

[English](./README.md)

通过 WebDAV 跨设备同步本地 [OpenAI Codex](https://github.com/openai/codex) 和 Claude Code 会话，提供 CLI 和本地 Web GUI。

## 为什么需要它

Codex 和 Claude Code 分别将会话保存在本机 `~/.codex` 和 `~/.claude` 目录。多台电脑工作时，会话不会跟着你走。codex-session-sync 提供跨设备同步：

- **冷同步** —— 写入前要求关闭所选客户端
- **覆盖前备份** —— 默认在覆盖本地或远端文件前保留副本
- **本地优先** —— 数据只发往你自己配置的 WebDAV 服务器，无第三方服务、无遥测

## 功能

| 功能 | 说明 |
|------|------|
| WebDAV 同步 | 与 Nextcloud、群晖、坚果云或任意 WebDAV 服务器双向同步 sessions / skills / plugins |
| Claude Code 同步 | 使用独立 WebDAV 目录同步项目会话、对应的 subagents/tool-results 及项目 memory |
| 增量同步 | 默认按文件级增量更新；新设备首次接入已有仓库时会做一次内容校验 |
| Web GUI | 仪表盘、会话浏览、同步实时进度（SSE）、备份管理 —— `http://localhost:7420` |
| 会话管理 | 按项目分组浏览、搜索、重命名（同步写回 Codex 自身 UI）、删除（清理 Codex 全部三处存储） |
| 登录方式合并 | 合并 ChatGPT 页面授权登录（`openai`）与 API key 登录（`custom`）相互隔离的会话列表 |
| Codex 备份恢复 | 时间戳快照、一键恢复、过期清理、删除 |
| 冲突策略 | `manual_abort` / `prefer_local` / `prefer_cloud` / `prefer_newer_mtime` |
| 安全防护 | Codex 进程检测、原子写入（tmp + rename）、路径穿越防护、合并/恢复前自动备份 |

## 环境要求

- Node.js **≥ 22.5**（会话重命名/删除/合并使用内建 `node:sqlite` 模块）
- 已安装 Codex CLI / Desktop 或 Claude Code（至少一台设备存在所选客户端的数据目录）
- Windows / macOS / Linux（Windows 实测最充分）

## 安装

```bash
npm install -g codex-session-sync-cli
```

安装后即可使用 `cxsync` 命令。也可以免安装直接运行：

```bash
npx codex-session-sync-cli
```

<details>
<summary>从源码安装</summary>

```bash
git clone https://github.com/shonngithub/codex-session-sync.git
cd codex-session-sync
npm install
npm install -g .
```

</details>

本地打包给多台设备安装：

```bash
npm install
npm test
npm pack --dry-run       # 先检查将要进入压缩包的文件
npm pack                 # 生成 codex-session-sync-cli-<version>.tgz
npm install -g ./codex-session-sync-cli-<version>.tgz
```

如果要发布到 npm：

```bash
npm login
npm version patch        # 发布新版本，不能重复使用已发布的版本号
npm publish --access public
```

发布前会自动执行 `prepublishOnly` 中的 `npm test`。发布后其他设备可直接执行
`npm install -g codex-session-sync-cli`，或使用 `npx codex-session-sync-cli`。

## 快速开始

```bash
# 1. 生成配置文件（~/.codex-session-sync/config.yml）
cxsync init-config

# 2. 编辑配置，填入 WebDAV 信息
#    webdav:
#      url: https://your-server/remote.php/dav/files/username
#      username: 用户名
#      password: 密码
#      remote_path: /codex-sync

# 3. 预检环境
cxsync doctor

# 4. 启动 Web GUI（自动打开浏览器）
cxsync            # 等价于 `cxsync serve`
```

纯命令行方式：

```bash
cxsync push --dry-run   # 预览本机 -> WebDAV
cxsync push             # 执行上传（必须先关闭 Codex）
cxsync pull --dry-run   # 预览 WebDAV -> 本机
cxsync pull             # 执行下载（必须先关闭 Codex）
# 通用入口：cxsync sync --direction push --apply

# Claude Code 使用相同 WebDAV 凭据，但有独立的远端目录和同步清单
cxsync push --client claude --dry-run
cxsync push --client claude       # 必须先关闭 Claude Code
cxsync pull --client claude       # 必须先关闭 Claude Code
```

## CLI 命令参考

```
cxsync init-config [--output <path>] [--force]     生成配置文件
cxsync validate                                    验证配置
cxsync doctor                                      预检诊断
cxsync plan [--client codex|claude]                查看同步计划（只读）
cxsync push [--client codex|claude] [--dry-run]    本机 -> WebDAV（默认执行）
cxsync pull [--client codex|claude] [--dry-run]    WebDAV -> 本机（默认执行）
cxsync sync --direction <direction> [--client codex|claude] --dry-run|--apply   通用同步入口
cxsync restore [--from <snapshot>] --apply         从备份恢复
cxsync sessions [--client codex|claude] [--project <name>]   列出本地会话 ID
cxsync merge-providers --list                      查看各登录方式的会话数
cxsync merge-providers --from openai --to custom --apply   合并登录方式
cxsync serve [--port 7420] [--no-open]             启动 Web GUI（默认命令，直接运行 `cxsync` 即可）
```

全局参数：`-c <配置路径>`、`-v`（详细日志）。

同步命令的 `--client` 默认值是 `codex`。退出码 `3` 表示所选客户端正在运行（请先关闭）。

## 典型工作流：机器 A → 机器 B

```bash
# 机器 A：关闭 Codex，然后上传
cxsync push

# 等待 WebDAV/云端同步完成

# 机器 B：关闭 Codex，然后下载
cxsync pull

# 列出会话 ID，并恢复同一个会话
cxsync sessions
codex resume --all <SESSION_ID>
```

`sessions/**` 是上下文正文，`session_index.jsonl` 是恢复索引。同步文件后必须用
`codex resume --all <SESSION_ID>` 恢复原会话；`cxsync sessions` 会输出可复制的 ID，直接运行 `codex` 会新建会话。rollout
里保存的 `cwd` 是创建会话时的绝对路径；两台机器的项目目录最好保持一致，否则使用
`codex resume --all` 查看所有目录下的会话，并在目标机器打开对应项目目录。项目源码、依赖和登录状态不由本工具同步。

## Claude Code 跨设备接续

Claude Code 默认使用独立的 WebDAV 目录 `<webdav.remote_path>-claude`
（例如 `/codex-sync-claude`）和本地 `claude_manifest_path` 清单。
可通过 `claude_remote_path` 指定其他远端目录；两种客户端共用 WebDAV 凭据。

```bash
# 机器 A：关闭 Claude Code 后上传
cxsync push --client claude

# 机器 B：关闭 Claude Code 后下载
cxsync pull --client claude
cxsync sessions --client claude
claude --resume <SESSION_ID>
```

`cxsync sessions --client claude` 会列出已同步的 `UUID.jsonl` 文件所对应的会话 ID。
仅同步 `~/.claude/projects/<project>/<UUID>.jsonl`、项目 `memory/**`，以及
`<UUID>/subagents/**` 和 `<UUID>/tool-results/**`。项目目录名由本机项目路径决定；
`claude --continue` 只查当前目录最近的会话。Claude Code 2.1.223 及更新版本可用
`claude --resume <SESSION_ID>` 跨本机项目查找已同步的会话；旧版需要保持相同项目路径，
或把下载后的会话 `.jsonl` 绝对路径传给 `--resume`。项目源码和依赖仍需自行同步。
Claude 凭据、设置、全局历史和其他本地状态不在同步范围内。

同步默认按文件级增量执行。每个客户端的历史基线保存在各自的本地清单；首次在新设备运行时，会对已有远端文件做一次内容校验，避免不同机器的 mtime 造成误覆盖。同步成功后，本地清单记录每个相对路径最近一次观测到的元数据，并以原子方式更新。相同信息也保存在各自的 WebDAV 目录下，文件名为内部清单 `.cxsync-manifest.json`；该文件不计入用户文件同步计划。

同步方向决定权威来源：

| 方向 | 行为 |
|------|------|
| `bidirectional` | 双向传播变更；两端同时变更时按冲突策略处理 |
| `push` | 以本地为来源上传变更；仅远端存在的文件保持不动 |
| `pull` | 以远端为来源下载版本；对应本地文件会被覆盖并先生成 `.bak` |

双向同步会对 `session_index.jsonl` 按会话 `id` 合并，保留两端各自新增的条目；同一 ID 有不同记录时，保留 `updated_at` 较新的整条记录。时间相同或无效时使用稳定规则选择记录。索引 JSONL 有损坏行或条目缺少字符串 `id` 时，同步会停止并报告行号，避免静默丢弃索引内容。单向 `push` / `pull` 仍按所选方向传播索引。

## Web GUI 页面

| 页面 | 功能 |
|------|------|
| Dashboard | Codex 进程状态、会话统计、快捷操作 |
| 会话管理 | 仅管理 Codex 会话：按项目分组、搜索、重命名、删除 |
| 同步 | Codex / Claude Code 选择、WebDAV 连接测试、计划预览、实时进度和日志流 |
| 备份恢复 | Codex 快照列表（含存储路径）、创建/恢复/删除、登录方式合并 |

## Codex 会话的存储结构（本工具触及的部分）

| 存储 | 用途 |
|------|------|
| `sessions/YYYY/MM/DD/rollout-*.jsonl` | 会话内容本体（JSONL，首行为 `session_meta`） |
| `session_index.jsonl` | `codex resume` 使用的索引 |
| `state_5.sqlite` → `threads` 表 | Desktop 的本机索引（包含绝对路径和登录元数据，本工具不跨设备覆盖） |

重命名写入 2+3（索引缺失条目时自动补建）；删除清理全部三处；登录方式合并改写 1+3 中的 `model_provider`。

## 配置说明

完整注释配置见 [`config.example.yml`](./config.example.yml)。关键参数：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `manifest_path` | `~/.codex-session-sync/manifest.json` | 文件级增量同步基线；请放在 `codex_home` 之外 |
| `claude_home` | `~/.claude` | Claude Code 本地数据目录 |
| `claude_manifest_path` | `~/.codex-session-sync/claude-manifest.json` | Claude Code 独立的增量同步清单 |
| `claude_remote_path` | `<webdav.remote_path>-claude` | Claude Code 独立的 WebDAV 目录，可选配置 |
| `sync.direction` | `bidirectional` | `bidirectional` / `push` / `pull` |
| `sync.session_mode` | `all` | 同步 Codex 全部日期目录，避免恢复时缺少旧会话 |
| `sync.compare` | `mtime` | `mtime` 或 `mtime_hash_fallback`（SHA-256 二次校验） |
| `conflict.policy` | `manual_abort` | 冲突解决策略 |
| `backup.compression` | `none` | `none`（目录）或 `zip` |
| `backup.retention_days` | `30` | 快照自动清理天数 |
| `server.port` | `7420` | Web GUI 端口（仅绑定 127.0.0.1） |

## REST API

Web GUI 背后是一套文档化的 REST API（`docs/API.md`）——会话、同步计划/执行（SSE）、备份、登录方式合并、WebDAV 测试，可集成到你自己的工具链。

## 开发

```bash
npm test        # 单元测试 + e2e（e2e 对内存 WebDAV 服务器执行完整同步循环）
npm run dev     # 在 :7420 启动 GUI 服务
```

项目结构见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 安全说明

- 所选客户端运行时拒绝同步；Codex 删除/合并也会检查 Codex 进程
- 开启 `backup.enabled` 时，同步覆盖本地文件前会保留 `.bak`，覆盖远端文件前也会保存副本；Codex 登录方式合并前会创建快照
- WebDAV 凭据仅存于本机 `config.yml`，绝不上传
- GUI 服务只绑定 `127.0.0.1`，局域网不可达
- 不同步 `auth.json`、token、API key 或 Desktop `state_5.sqlite`；跨设备优先使用 CLI `codex resume`
- WebDAV 根目录只读取 `sessions/**`、`session_index.jsonl`、`skills/**`、`plugins/**`，其他文件会被忽略
- Claude Code 使用独立 WebDAV 目录，仅同步项目会话、项目 memory、会话 subagent/tool-result 文件；专用凭据文件、设置、全局历史和其他状态文件不会上传，但会话和 memory 内容本身可能包含敏感信息

## 致谢

设计参考了 [codexSync](https://github.com/kroxiksut/codexSync)（冷同步交接、覆盖前备份）以及 codex-session-toolkit 系列（Web UI 会话浏览、重命名写回）。

## License

MIT
