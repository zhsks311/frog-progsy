---
title: 模型混合
description: "在 Model Mixing 仪表盘标签页中，把多个模型合成一个 frogp/mix。无需编辑 JSON，也可以直接使用预设。"
---

模型混合让 Claude Code 只选择一个模型名 `frogp/mix`，背后却由多个模型一起产出答案。你不需要理解配置 JSON：打开仪表盘，选择预设，启用，然后在 Claude Code 里选择 `frogp/mix` 即可。

> 模型混合是质量/成本功能，和 auto 模式安全分类器完全无关。

## 这个功能做什么

可以把它理解成：把同一个问题交给几位专家同时回答，再由一位编辑比较这些答案，写出最终稿。

仪表盘预设默认使用 `fusion` 流程：

1. **回答器作答** — 多个回答器同时回答同一个请求。
2. **分类器比较** — 分类器比较各个答案的优点、缺口和冲突。
3. **最终回答器撰写** — 最终回答器写出 Claude Code 最终收到的答案。

**Research** 预设还会加入改写步骤（`multiround`）和网页搜索。改写步骤是在最终答案前做有上限的修订。网页搜索只在回答器内部使用，不会暴露成 Claude Code client tool。

在仪表盘的**方式**选择器中选择**分配**时，不再让所有模型作答：分配器读取请求，把它交给名单中最合适的一个模型 — 每个请求 1–2 次调用，快且省。分配器会参考每个模型的说明和你写的分配规则。

## 什么时候开启，什么时候关闭

| 选择 | 速度 | 成本/用量感受 | 适合场景 |
| --- | --- | --- | --- |
| 关闭 | 最快 | 1 次普通模型请求 | 需要快速回答、正在排查延迟，或不需要多答案比较时 |
| Low | 比单模型慢 | 每个用户请求变成 4 次答案调用，0 次搜索 | 想在不搜索的情况下试用小型专家组时 |
| Balanced | 比 Low 慢 | 每个用户请求变成 5 次答案调用，0 次搜索 | 更重视质量，但不需要 Research 的搜索/改写时 |
| Research | 最慢 | 每个用户请求变成 11 次答案调用，最多 3 次专家组搜索 | 能等待，且分析/编码质量比速度更重要时 |

换句话说，一次 Claude Code 请求会在内部变成多次模型调用。Low 是 4 次答案调用，Balanced 是 5 次，Research 是 11 次并最多追加 3 次内部搜索。因此它通常会更慢，也会消耗更多用量。

通俗地说：在内部 60 题测试集（`local-suite-v1`）上，Research 预设的得分比最强单一模型（`gpt-5.5`）高约 13%，即使考虑误差也至少高 6%（统计表示：delta `+0.1333`，95% CI `[+0.0583, +0.2000]`）。最难的推理任务没有改善，收益集中在分析和编码；评分由单个 `gpt-5.5` 模型完成。响应速度方面，一半在 29 秒内返回（p50 = 中位数），100 次中有 95 次在约 3 分 42 秒内返回（p95 = 接近最差情况）。该结论仅限这套测试集。

## 在仪表盘中使用

1. 运行 `frogp gui`，打开本地仪表盘。
2. 打开 **Model Mixing** 标签页。
3. 选择 **Low**、**Balanced** 或 **Research**。预设卡片会显示服务器计算出的答案调用数和搜索调用数。
4. 如果预设会覆盖现有自定义 Model Mixing 设置，仪表盘会要求确认。取消则不会修改已保存配置。
5. 打开 **Enable** 开关。保存前，仪表盘会显示当前预计调用数和延迟警告。取消不会保存；保存失败时，开关会恢复原状。
6. 在 Claude Code 中选择 `frogp/mix`。

应用预设不会自动启用 Model Mixing。启用始终是单独的开关，所以查看或编辑预设不会悄悄改变 Claude Code 行为。

这个页面也可以查看和编辑回答器名单、分类器、最终回答器以及高级设置。多数用户不用理解这些高级字段，直接用预设就够了。

模型隐藏/显示由 **Model Picker / Models** 页面负责，不属于 Model Mixing。混合模型的名称（`aliasId`）可以在页面底部的**模型名称**面板中修改；名称必须包含 `/` 才会出现在模型列表中。改名后，隐藏状态不会跟随旧名称；新名称会被当成模型列表中的新条目。

## 在混合中使用 Anthropic

此页面的 provider 列表来自已配置的 AI Accounts，而不是 Claude Code 原生拥有的所有模型。如果没有看到
Anthropic，请先在 AI Accounts 中添加 **Anthropic Claude**。新配置默认包含 `anthropic` forward-auth
provider，但旧配置或手写配置可能没有。

Anthropic 子调用有两条认证路径，请求本身不会因此改变：

- **Forward（默认，零托管）**：frogprogsy 不存储 Claude token，混合流程中的 Anthropic 子调用会复用 Claude Code 发到 gateway 的真实 `Authorization` 或 `x-api-key` header。因此只有当请求来自已注入且已登录的 Claude Code home 时，Anthropic 才能在 Model Mixing 中工作；脚本或 API caller 选了 `frogp/mix` 却没有转发 Anthropic 认证 header 时，这一路子调用没有凭据，需要改用 Anthropic API-key provider。
- **Isolated grant（可选托管）**：如果先用 `frogp claude grants add` 发放一个隔离订阅 grant，并用 `frogp providers set <name> --auth claude-grant --grant <id>` 绑定，混合流程会从该 grant 自己的 scoped 存储取 token。这带来 headless 就绪：即使 caller 没有转发 Anthropic header，被绑定的 Anthropic 子调用也能工作。凭据是隔离的——grant token 只附加到它绑定的 provider，Codex、xAI、Kimi 等其他 provider 和 fallback 都不会收到 Anthropic token，反之亦然；Codex OAuth 保持独立。发放与绑定 grant 的细节见 [Claude Code 接入](/frog-progsy/zh-cn/guides/claude-integration/)。

内置 Low/Balanced/Research 预设是已测量的 Codex profiles。Anthropic 可以手动作为回答器、评审或合成者加入，
但 Claude+Codex 组合质量不属于下方 F3 评估声明。

## 仪表盘高级设置

**高级设置**面板中的每一项都对应一个 `modelMixing` 配置字段：

| 仪表盘项 | 含义 | 配置字段 |
| --- | --- | --- |
| 回答器可见范围 | 回答器只看当前请求，还是看完整对话。默认是"仅当前请求"。完整对话可能提升质量，但会增加用量。 | `fusion.contextMode`（`task`/`full`） |
| 分类器可见范围 | 同样的选择，作用于分类器。默认是"仅当前请求"。 | `fusion.judgeContextMode`（`task`/`full`） |
| 网页搜索 | 允许回答器在作答前搜索网页。仅在回答器内部使用，不会作为 Claude Code 工具暴露。 | `fusion.panelWebSearch.enabled` |
| 网页搜索次数限制 | 分别限制单个回答器的次数和整个请求所有回答器合计的次数。例：每个 1 次、合计 3 次时，即使有四个回答器也最多搜索 3 次。 | `fusion.panelWebSearch.maxSearchesPerPanel`、`.maxTotalSearches` |
| 添加改写步骤 | 在定稿前增加一步有限的润色。调用更多，成稿更好。 | `fusion.multiround.enabled` |
| 改写限制 | 最多重复次数 / 每轮草稿数 / 额外调用上限。 | `fusion.multiround.maxRounds`、`.branchFactor`、`.budgetCalls` |
| 时间限制 | 整个步骤 / 单个回答器的超时（毫秒）。不限制最终流式回答。 | `stageTimeoutMs`、`panelTimeoutMs` |

## 高级/自动化：直接编辑 JSON

推荐使用仪表盘预设。直接编辑 JSON 适合自动化、审查，或把已验证的配置复制到另一台机器。

在 `~/.frogprogsy/config.json` 中加入 `modelMixing`，重启 proxy，然后在 Claude Code 中选择 `frogp/mix`。发往该 alias 的请求会走混合路径，其他模型照常路由。

## 组合方式

| 方式 | 行为 | 上游答案调用 |
| --- | --- | ---: |
| `route`（默认） | 选择一个模型。`mode: "coordinator"` 使用一次 coordinator 调用；`mode: "rules"` 是确定性选择。 | 1–2 |
| `fusion` | 专家组并行回答，评审分析，再由合成者写最终答案。 | panel + 2 |
| `pipeline` | 固定的 Thinker → Worker → Verifier 链。 | 最多 3 |

中间阶段默认以 `thinking` 块呈现（`surfaceStages: true`）。可用 `surfaceStages: false` 隐藏。

## Fusion 上下文与超时

`fusion.contextMode` 控制专家组 prompt 上下文，`fusion.judgeContextMode` 控制评审 prompt 上下文。二者相互独立，默认都是 `"task"`。设为 `"full"` 时，对应 pre-final prompt 会包含原始 system prompt 与消息历史。Pre-final 阶段仍不会收到 client tools。

`stageTimeoutMs` 和 `panelTimeoutMs` 只应用于 buffered pre-final 阶段：panel、judge、pipeline pre-final、multiround score/refine。它们不限制 final streamed synthesizer。Final synthesizer 会带着原始请求上下文和 client tools 流式输出，只受 client abort/SSE idle 行为约束。

## 示例配置

下面所有配置都是 opt-in。Low 和 Balanced 是便捷预设。Research/F3 只在上述 caveats 下 accepted on `local-suite-v1`。答案调用估算不包含 eval harness 单独的 judge-grading calls。

| 预设 | 用途 | 每次请求答案调用 | 搜索调用 |
| --- | --- | ---: | ---: |
| Low | 小型 full-context fusion 专家组 | `4` | `0` |
| Balanced | 更大的 full-context fusion 专家组 | `5` | `0` |
| Research | full context、专家组搜索、受限 multiround；带 caveats 的 `local-suite-v1` accepted | `11` | 最多 `3` |

```jsonc
{
  "modelMixing": {
    "enabled": true,
    "aliasId": "frogp/mix",
    "combine": "fusion",
    "coordinator": { "provider": "codex", "model": "gpt-5.5" },
    "stageTimeoutMs": 60000,
    "fusion": {
      "contextMode": "full",
      "judgeContextMode": "full",
      "panel": [
        { "provider": "codex", "model": "gpt-5.5" },
        { "provider": "codex", "model": "gpt-5.4" },
        { "provider": "codex", "model": "gpt-5.4-mini" }
      ],
      "judge": { "provider": "codex", "model": "gpt-5.5" },
      "synthesizer": { "provider": "codex", "model": "gpt-5.5" },
      "panelWebSearch": {
        "enabled": true,
        "maxSearchesPerPanel": 1,
        "maxTotalSearches": 3,
        "tiers": ["no_key"],
        "timeoutMs": 10000
      },
      "multiround": {
        "enabled": true
      }
    }
  }
}
```

`panelWebSearch` 是 synthetic/internal panel-only search。它只支持 `fallback_model`、`search_api` 和 `no_key` tiers，绝不会作为 Claude Code client tool 暴露。

`multiround` 是初始专家组之后的受限 branch/refine/score loop。只有所选预设或配置启用时才会运行。

## 成本与评估备注

- Fusion panel size `N` 在不含 multiround 增量时成本是 `N + 2` answer calls。
- Panel search calls 受 `panelSize * maxSearchesPerPanel` 与 `maxTotalSearches` 双重限制；Research 仪表盘预设最多 `3` 次。
- 通俗地说，Research 的依据是：在内部 60 题测试集上，得分比最强单一模型（`gpt-5.5`）高约 13%，考虑误差后也至少高 6%（delta `+0.1333`、95% CI `[+0.0583, +0.2000]`）。该依据仅限这套测试集（suite-v1）。
- hard reasoning 子集没有改善；当分析/编码质量比延迟更重要时再使用 Research。
- 已评估的配置只混合了 Codex 系列模型。跨提供方组合（例如 Claude 与 Codex 混用）在功能上受支持，但质量尚未测量。
- Eval server 使用隔离的 `FROGPROGSY_HOME`，并通过直接 import `startServer()` 的 eval-only `serve` helper 启动。不要用 `frogp start`，也不能改动用户 `~/.claude` 或默认 `~/.frogprogsy`。

全部字段见[配置](/frog-progsy/zh-cn/reference/configuration/#model-mixing-fields)。
