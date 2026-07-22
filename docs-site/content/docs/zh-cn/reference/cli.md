---
title: CLI 命令
description: "frogp 命令完整契约：setup、relay lifecycle、provider login、refresh、models、dashboard、recovery、update、help。"
---

本文档站点的 `/zh-cn/` 路径是 FrogProgsy 的官方完整文档表面。README 只覆盖第一次成功的快速开始；命令完整契约以本参考页为准。

`frogp` 是控制本地 Claude Code relay 的 command surface。命令主要分三类：

- 启动或停止本地 relay process。
- 注入、刷新或恢复 FrogProgsy 拥有的 Claude Code settings/catalog/cache entry。
- 管理 provider credential、模型可见性、dashboard 与 diagnostic output。

Help、status、models、version 类命令是 read-only。`start`、`stop`、`restore`、`refresh`、`init`、`login`、`logout`、`uninstall` 会修改本地状态。

## 基本语法与通用规则

```bash
frogp <command> [options]
frogp <command> --help
frogp help [command]
frogp --version
```

- 未知 command 会返回失败 exit code，脚本可以信任结果。拼写接近时会输出 `Did you mean: frogp <command>?` 建议（同一建议引擎也覆盖 `frogp login` 的 provider 拼写错误）。
- `--help`、`-h` 或 command 后的 `help` 会输出该 command 的 usage。`frogp help <command>` 输出相同的 usage。
- 默认 relay port 是 `10100`。`frogp start --port <port>` 可指定本次运行监听端口。
- 注入到 Claude Code 的 endpoint 指向 loopback relay；restore 路径只移除 FrogProgsy-owned change。

### 机器输出与颜色

- `frogp status --json` 和 `frogp models --json` 是机器输出模式。JSON 模式下 stdout 只包含恰好一个 JSON 文档（加换行），所有诊断信息走 stderr，JSON 中绝不包含 ANSI 颜色码。
- 人类可读输出可以使用最小 ANSI 调色板。颜色只在 TTY 输出时启用；`NO_COLOR` 设为非空值时始终禁用（最高优先级）；管道/重定向（non-TTY）默认禁用；`FORCE_COLOR=1` 可在 non-TTY 下强制启用（但非空 `NO_COLOR` 优先）。
- `status`/`models` 的未知 flag 会以 exit code 1 失败并在 stderr 输出 usage 提示。

## Setup and relay lifecycle

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp init` | config，可选 Claude Code settings | 打开 provider 与 port setup wizard。空输入（Enter）选择文档化的默认 provider（`codex`）；无效输入会重新询问而不会误入 custom 设置。所有回答验证完成后才写入（all-or-nothing）：EOF 或中断时不写任何文件并以非零退出。Claude Code 注入只在验证过的 yes 之后执行。 |
| `frogp start [--port <port>]` | PID guard, Claude Code catalog/cache, launcher shim | 启动 local relay，执行 model discovery/catalog sync，并重新生成托管的 `claude`/profile launcher。若已有 healthy PID，会要求先运行 `frogp stop` 并退出。 |
| `frogp refresh` | 必要时 relay，Claude Code catalog/cache, launcher shim | 确认 relay 是否运行；若未运行则以 detached 方式启动，然后为所有已配置的 Claude Code 目录重新同步 config/catalog/model cache/launcher。 |
| `frogp stop` | process, Claude Code settings/catalog | 停止 proxy，并为所有已配置的 Claude Code 目录恢复 native Claude Code 状态。托管 launcher 会保留；proxy 停止时它们直通 native Claude Code。 |
| `frogp restore` | Claude Code settings/catalog | 不停止运行中的 proxy，只从所有已配置的 Claude Code 目录中移除 FrogProgsy-owned Claude Code settings/catalog entry。没有 active proxy 时，托管 launcher 会直通 native Claude Code。 |
| `frogp uninstall` | config, Claude Code settings/catalog, launcher shim, installed package | 移除 FrogProgsy local config，恢复 native Claude Code 状态，移除包含托管 launcher 的 config directory，并移除全局包。 |
| `frogp status [--json]` | 无 | 输出 PID guard，在 active port 上检查 relay health，并给出 dashboard URL。有 PID 但无响应时提示 `frogp refresh`；未运行时提示 `frogp start`。`--json` 输出稳定 schema 快照：`running`、`healthy`、`pid`、`port`、`dashboardUrl`、`recovery`，以及固定字段的 `watchdog` 对象（`present`、`attempts`、`gaveUpAt`、`unreadable`）— 绝不暴露 watchdog 文件的 raw 字段。relay 停止时 exit code 仍为 0。 |

## Provider and account

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp login --list` | 无 | read-only provider 列表：输出 OAuth 组（codex、xai、kimi）、API-key 组以及 `openai` 别名说明，然后 exit 0。 |
| `frogp login codex` | OAuth store, config | 创建 OpenAI Codex/ChatGPT OAuth lane。 |
| `frogp login openai` | config | 保存 OpenAI API-key provider（`openai` 是 `openai-apikey` 的别名；ChatGPT 账号登录用 `codex`）。 |
| `frogp login xai` | OAuth store, config | 创建 xAI OAuth lane。 |
| `frogp login kimi` | OAuth store, config | 创建 Kimi OAuth lane。 |
| `frogp login <catalog-provider>` | config 或 OAuth store | 添加 provider registry 中的 API-key/OAuth/local provider。拼写接近时会输出 `Did you mean: frogp login <provider>?` 建议；OAuth 失败以 `Login failed for <provider>: <原因>` 加重试指引报告，而不是 raw 堆栈。 |
| `frogp logout <provider>` | OAuth store | 删除该 provider 的已保存 OAuth credential。缺少参数或该 provider 未登录时会失败，并列出当前已保存的登录。它不是 API-key provider 删除命令。 |

Credential 位置与暴露规则：

- OAuth credential 存在 `~/.frogprogsy/auth.json`。
- API-key provider 存在 `~/.frogprogsy/config.json`。
- 直接编辑时建议使用 `${ENV_VAR}` 或 `$ENV_VAR` reference，而不是 literal key。
- Request log、usage log、dashboard safe log 不保存 API key、OAuth token、prompt body、account identity。

## Claude Code 目录

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp claude list` | 必要时 config migration | 列出具名 Claude Code 配置目录，以及 stable id、target directory、injection state、auth state。 |
| `frogp claude add <name> --home <path>` | config | 为 `~/.claude-work` 这样的指定 Claude Code 配置目录添加用户命名目录。 |
| `frogp claude rename <name-or-id> <new-name>` | config | 修改显示名称，同时保留 header、backup、model overlay、status 使用的 stable `cp_...` id。 |
| `frogp claude remove <name-or-id>` | config | 移除非最后一个目录。 |
| `frogp claude inject|refresh|restore <name-or-id>` | 目标 Claude Code 目录 | 仅对选定目录注入、刷新或恢复。Header injection 会保留无关的 `ANTHROPIC_CUSTOM_HEADERS` 条目。 |
| `frogp claude reload-models <profile-id>` | 目标 Claude Code 目录 catalog/cache | 不自动启动 proxy，只重建所选 Claude Code 目录的 gateway picker catalog/cache。若 proxy 已停止，会输出 `frogp refresh` 恢复指引。 |
| `frogp claude run <name-or-id> -- <claude args...>` | process env only | 使用该目录的 `CLAUDE_CONFIG_DIR`、`ANTHROPIC_BASE_URL`、gateway discovery 和 `X-Frogp-Claude-Profile` 启动 `claude` 的底层 escape hatch。日常使用应是 plain `claude` 或生成的 `claude-work`/`claude-personal` 等 alias。 |

Claude Code 持有 Claude 订阅登录。FrogProgsy 不保存、导入、刷新、记录或显示 Claude 订阅 OAuth token。

`frogp start`/`frogp refresh` 会在 `~/.frogprogsy/bin` 中生成 launcher shim：默认目录得到 `claude`，每个目录会从 profile 名称与 home basename 派生安全 alias，例如 `claude-work`、`claude-personal`。把该目录放到 native Claude Code binary 之前的 `PATH`，或使用 package 提供且在 PATH 中优先命中的 `claude` bin。Launcher 会把真实 Claude Code 可执行文件固定到 `FROGP_REAL_CLAUDE`，避免递归进入 frogprogsy shim 或临时 cmux shim。Proxy 停止时，它们只保留所选 Claude 目录 env 并直通 native Claude Code。

## Models

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp models [--json]` | 无 | 路由模型列表的在线专用视图。需要运行中的 proxy，直接读取现有 `GET /api/models` — 与 dashboard 和 Claude Code catalog 使用的同一列表。文本输出按 provider 分组，并按原样显示响应字段（`disabled`、context window、modality、reasoning effort）。`--json` 原样输出 `/api/models` 数组。relay 停止时以 `frogp start` 指引失败；有记录但无响应时提示 `frogp status`/`frogp refresh`。绝不离线合成模型列表。 |

## Catalog and Claude Code cache

`frogp refresh` 会合并各 provider 的 `/models` 结果与 `config.json` 中的 static model list，生成 Claude Code 可见的 `provider/model` alias，然后为所有已配置的 Claude Code 目录 invalidate model cache。`frogp claude reload-models <profile-id>` 范围更窄：它只准备一个 Claude Code 目录的 gateway picker catalog/cache，且不会自动启动 proxy。若 proxy 已停止，请按输出的 `frogp refresh` 指引先恢复 relay。
`disabledModels` 会从 catalog 与 `/v1/models` 中排除，`subagentModels` 会优先放到 Claude Code subagent picker 前面的 slot。
Claude Code 会在 session start 或 resume 时重新获取 `/v1/models`。重新打开已经打开的 `/model` 屏幕不会 hot reload picker；需要启动新的 Claude Code session 或 resume，让 models endpoint 再次被获取。Dashboard/API model list reload 与 Claude Code picker recovery 是分开的。

## Dashboard

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp gui` | 必要时 relay process | 打开 local dashboard；若 proxy 不存在则 auto-start，等待其变为 healthy 后再用实际的 active listen port 打开 URL。 |

Dashboard 是查看 config、route、safe request log、usage summary 的运营表面。诊断失败请求时与 [`/zh-cn/guides/troubleshooting/`](/frog-progsy/zh-cn/guides/troubleshooting/) 一起使用。

## Recovery

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp restore` | Claude Code settings/catalog | 最窄的 clean restore path。 |
| `frogp stop` | process + restore | 需要同时关闭 relay 时使用。 |
| `frogp uninstall` | config + restore + package | 需要移除 FrogProgsy 安装痕迹时使用。 |

## Update, version, and help

| Command | Mutates | Effect |
| --- | --- | --- |
| `frogp update [--no-restart]` | installed package | 使用 Bun 更新到已发布的最新版本并重启 proxy（`--no-restart` 跳过重启）。若在包注册表中找不到该包，会在不做任何更改的情况下明确失败；source checkout 会被提示使用 `git pull && bun install`。 |
| `frogp version` | 无 | 输出已安装的 frogprogsy version（`--version` / `-v` 相同）。 |
| `frogp help [command]` | 无 | 输出完整 command map，或某个 command 的 usage。 |
| `frogp <command> --help` | 无 | 输出该 command usage。 |
