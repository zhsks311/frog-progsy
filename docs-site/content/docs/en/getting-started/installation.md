---
title: Install frogp
description: "Install the FrogProgsy local relay command and check what you need before the first successful route."
---

`frogp` is the FrogProgsy command. It starts a local HTTP relay in front of Claude Code and routes traffic only to providers you configure. This page stops at installation. Add the first provider and choose the default model from the dashboard in the next step.

## What you need

| Requirement | Notes |
| --- | --- |
| Bun 1.1+ | Runtime for the `frogp` binary. Bun must be on `PATH` even when you install from a source checkout. |
| Claude Code | CLI, App, or SDK. FrogProgsy uses gateway settings and does not patch binaries. |
| Provider lane | API key, OAuth account, forward provider, local server, or custom OpenAI-compatible endpoint. |

## Install

Until the package is published to the registry, install from a source checkout:

```bash
git clone https://github.com/zhsks311/frog-progsy.git
cd frog-progsy
bun add -g .
frogp --help
```

After the package is published, the normal install command will be:

```bash
bun add -g frogprogsy
```

After installation, start the relay directly:

```bash
frogp start
```

`frogp start` opens the local gateway and synchronizes the FrogProgsy-owned Claude Code settings and model catalog. Provider setup, default provider/model selection, and the first `claude` request continue in [First Relay Run](/frog-progsy/getting-started/quickstart/).

## Docker Compose

The repository includes a tested `Dockerfile` and `docker-compose.yml` for running the relay as a containerized service:

```bash
docker compose up --build
```

The container writes FrogProgsy state under `/config`, exposed as the `frogprogsy-config` volume. Its entrypoint seeds `config.json` with `hostname: "0.0.0.0"` so Docker port publishing can reach the relay, and the Compose file sets `FROGP_EXTERNAL_SUPERVISOR=1` so Docker owns crash recovery instead of the in-process watchdog.

By default the host receives `http://localhost:10100`. To use a different host port without changing the container port:

```bash
FROGP_HOST_PORT=10190 docker compose up --build
```

Point Claude Code at the host-exposed gateway, for example `ANTHROPIC_BASE_URL=http://localhost:10100`.

## Advanced installation notes

- `frogp init` is the alternate setup path when you need a CLI wizard. The first-success path is dashboard-first with `frogp gui`.
- Recovery commands such as `frogp restore` and `frogp uninstall` are covered in the [CLI reference](/frog-progsy/reference/cli/).
- Operators who must edit JSON directly should use the [Configuration reference](/frog-progsy/reference/configuration/).
- Source checkouts and the dashboard development server are contributor/development workflows, not the normal install path.

Next: [First Relay Run](/frog-progsy/getting-started/quickstart/).
