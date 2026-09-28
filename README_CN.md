# codex-session-sync

[English](./README.md)

本地 [OpenAI Codex](https://github.com/openai/codex) 会话同步、备份与管理工具——通过任意 WebDAV 服务器跨机器同步，提供 CLI 和本地 Web GUI。

## 为什么需要它

Codex（CLI / Desktop / IDE 插件）把所有会话状态存在本地 `~/.codex` 目录。多台电脑工作时，会话不会跟着你走。codex-session-sync 安全地解决这个问题：

- **冷同步** —— 仅在 Codex 关闭后执行，杜绝写入中途损坏状态文件
- **覆盖前备份** —— 每个破坏性操作前先自动创建快照
- **本地优先** —— 数据只发往你自己配置的 WebDAV 服务器，无第三方服务、无遥测

## 功能

| 功能 | 说明 |
|------|------|
| WebDAV 同步 | 与 Nextcloud、群晖、坚果云或任意 WebDAV 服务器双向同步 sessions / skills / plugins |
| 增量同步 | 默认按文件级增量更新；新设备首次接入已有仓库时会做一次内容校验 |
| Web GUI | 仪表盘、会话浏览、同步实时进度（SSE）、备份管理 —— `http://localhost:7420` |
| 会话管理 | 按项目分组浏览、搜索、重命名（同步写回 Codex 自身 UI）、删除（清理 Codex 全部三处存储） |
| 登录方式合并 | 合并 ChatGPT 页面授权登录（`openai`）与 API key 登录（`custom`）相互隔离的会话列表 |
| 备份恢复 | 时间戳快照、一键恢复、过期清理、删除 |
| 冲突策略 | `manual_abort` / `prefer_local` / `prefer_cloud` / `prefer_newer_mtime` |
| 安全防护 | Codex 进程检测、原子写入（tmp + rename）、路径穿越防护、合并/恢复前自动备份 |

## 环境要求

- Node.js **≥ 22.5**（会话重命名/删除/合并使用内建 `node:sqlite` 模块）
- 已安装 Codex CLI 或 Codex Desktop（存在 `~/.codex` 目录）
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
```

## CLI 命令参考

```
cxsync init-config [--output <path>] [--force]     生成配置文件
cxsync validate                                    验证配置
cxsync doctor                                      预检诊断
cxsync plan                                        查看同步计划（只读）
cxsync push [--dry-run]                            本机 -> WebDAV（默认执行）
cxsync pull [--dry-run]                            WebDAV -> 本机（默认执行）
cxsync sync --direction <direction> --dry-run      通用同步入口
cxsync restore [--from <snapshot>] --apply         从备份恢复
cxsync sessions [--project <name>]                 列出本地会话
cxsync merge-providers --list                      查看各登录方式的会话数
cxsync merge-providers --from openai --to custom --apply   合并登录方式
cxsync serve [--port 7420] [--no-open]             启动 Web GUI（默认命令，直接运行 `cxsync` 即可）
```

全局参数：`-c <配置路径>`、`-v`（详细日志）。

退出码：`3` = Codex 正在运行（请先关闭）。

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

同步默认按文件级增量执行。当前设备的历史基线保存在本地清单；首次在新设备运行时，会对已有远端文件做一次内容校验，避免不同机器的 mtime 造成误覆盖。同步成功后，本地清单记录每个相对路径最近一次观测到的元数据，并以原子方式更新。相同信息也保存在 WebDAV 的 `webdav.remote_path` 根目录下，文件名为内部清单 `.cxsync-manifest.json`；该文件会保留在远端，不计入用户文件同步计划。

同步方向决定权威来源：

| 方向 | 行为 |
|------|------|
| `bidirectional` | 双向传播变更；两端同时变更时按冲突策略处理 |
| `push` | 以本地为来源上传变更；仅远端存在的文件保持不动 |
| `pull` | 以远端为来源下载版本；对应本地文件会被覆盖并先生成 `.bak` |

## Web GUI 页面

| 页面 | 功能 |
|------|------|
| Dashboard | Codex 进程状态、会话统计、快捷操作 |
| 会话管理 | 按项目分组、搜索、双击重命名、删除 |
| 同步 | WebDAV 连接测试、计划预览、实时进度和日志流 |
| 备份恢复 | 快照列表（含存储路径）、创建/恢复/删除、登录方式合并 |

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
| `sync.direction` | `bidirectional` | `bidirectional` / `push` / `pull` |
| `sync.session_mode` | `all` | 同步全部日期目录，避免恢复时缺少旧会话 |
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

- 同步/删除/合并在 Codex 运行时拒绝执行（进程检测 + sqlite 锁安全）
- 每次覆盖/合并/恢复前自动创建快照
- WebDAV 凭据仅存于本机 `config.yml`，绝不上传
- GUI 服务只绑定 `127.0.0.1`，局域网不可达
- 不同步 `auth.json`、token、API key 或 Desktop `state_5.sqlite`；跨设备优先使用 CLI `codex resume`
- WebDAV 根目录只读取 `sessions/**`、`session_index.jsonl`、`skills/**`、`plugins/**`，其他文件会被忽略

## 致谢

设计参考了 [codexSync](https://github.com/kroxiksut/codexSync)（冷同步交接、覆盖前备份）以及 codex-session-toolkit 系列（Web UI 会话浏览、重命名写回）。

## License

MIT
