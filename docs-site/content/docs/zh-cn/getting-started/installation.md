---
title: 安装 frogp
description: "安装 FrogProgsy local relay command，并检查进入首次成功路径前的准备项。"
---

`frogp` 是 FrogProgsy command。它在 Claude Code 前启动 local HTTP relay，traffic 只会 route 到你配置的 provider。
本页只覆盖安装。第一个 provider 与默认模型会在下一步通过 dashboard 设置。

## 需求

| 需求 | 说明 |
| --- | --- |
| Bun 1.1+ | `frogp` binary runtime。即使从 source checkout 安装，Bun 也必须在 `PATH` 中。 |
| Claude Code | CLI、App、SDK。FrogProgsy 使用 gateway settings，不 patch binary。 |
| Provider lane | API key、OAuth account、forward provider、local server 或 custom OpenAI-compatible endpoint 之一 |

## 安装

在包发布到 registry 前，请从 source checkout 安装：

```bash
git clone https://github.com/zhsks311/frog-progsy.git
cd frog-progsy
bun add -g .
frogp --help
```

发布后，可以使用常规安装命令：

```bash
bun add -g frogprogsy
```

安装完成后直接启动 relay。

```bash
frogp start
```

`frogp start` 会打开本地 gateway，并同步 Claude Code 使用的 FrogProgsy-owned settings 与 model catalog。
Provider 添加、默认 provider/model 选择、第一条 `claude` 请求在 [首次 Relay 运行](/frog-progsy/zh-cn/getting-started/quickstart/) 中继续。

## Docker Compose

仓库包含经过验证的 `Dockerfile` 和 `docker-compose.yml`，可以把 relay 作为容器服务运行：

```bash
docker compose up --build
```

容器会把 FrogProgsy 状态写到 `/config`，该路径由 `frogprogsy-config` volume 持久化。Entrypoint 会把 `config.json` 的 `hostname` 设置为 `"0.0.0.0"`，让 Docker 端口发布能访问 relay；Compose 文件设置 `FROGP_EXTERNAL_SUPERVISOR=1`，因此 crash recovery 由 Docker 负责，而不是由进程内 watchdog 负责。

默认 host 地址是 `http://localhost:10100`。如果只想改变 host 端口、不改变容器端口：

```bash
FROGP_HOST_PORT=10190 docker compose up --build
```

让 Claude Code 指向宿主机暴露出来的 gateway，例如 `ANTHROPIC_BASE_URL=http://localhost:10100`.

## 高级安装备注

- `frogp init` 是需要 CLI wizard 时使用的替代配置路径。首次成功路径以 `frogp gui` dashboard 为准。
- `frogp restore` 与 `frogp uninstall` 等恢复命令见 [CLI reference](/frog-progsy/zh-cn/reference/cli/)。
- 必须直接编辑 JSON 的 operator 可使用 [Configuration reference](/frog-progsy/zh-cn/reference/configuration/)。
- Source checkout 与 dashboard development server 只在 contributor/development workflow 中需要。

下一步：[首次 Relay 运行](/frog-progsy/zh-cn/getting-started/quickstart/)。
