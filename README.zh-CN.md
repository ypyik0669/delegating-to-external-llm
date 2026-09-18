# delegating-to-external-llm

[![ci](https://github.com/ypyik0669/delegating-to-external-llm/actions/workflows/ci.yml/badge.svg)](https://github.com/ypyik0669/delegating-to-external-llm/actions/workflows/ci.yml)

[English](README.md) | **中文**

一个 Claude Code 插件：让 Claude 只当**架构师**，把**全部实现工作**交给你**自己的 OpenAI 兼容中转**（任意 base URL + API key）上的外部模型。Claude 负责写 spec、路由任务、核对 diff，并在报告完成前让一个干净上下文的 Claude 顾问给出 ship / fix-first / rethink 裁定。Claude 自己一行实现代码都不写。

架构模式源自 Dan McAteer 的 [fable-advisor](https://github.com/DannyMac180/fable-advisor)，改造为"单一中转模型 + 两种投递方式 + 硬性门禁"。

## 为什么

- **贵的 token 花在判断上，不花在打字上。** Claude 的 token 用于拆解、写 spec、下裁定，中转模型负责出量。
- **天然跨厂商交叉检查。** 代码来自非 Anthropic 模型，Claude 的验证和顾问评审是真正的第二意见。
- **不会悄悄漂移。** spec 先过静态检查再花钱，改动被围栏限制在 spec 的 FILES 内，通道失败会大声报告（`unavailable`、`refused`、`SCOPE VIOLATION`），报告里带通道自己重跑的验证结果，可选钩子在委托模式下物理禁止 Claude 直接改仓库文件。
- **靠证据，不靠感觉。** 每次通道调用都记入用量账本，`/delegating-to-external-llm:usage` 直接告诉你外部模型到底干了多少。

## 工作方式

```
你 ──► Claude（架构师）
        │  六段式 spec + REASONING: <档位>
        ├──► codex-implementer   codex exec ──► 你的中转 ──► 模型自己改仓库、跑测试
        ├──► relay-implementer   llm.mjs    ──► 你的中转 ──► 返回文本，逐字应用
        │  LANE REPORT（STATUS、CHANGES、VERIFIED …）
        ├──► llm-advisor（Claude，只读，干净上下文）──► ship / fix-first / rethink
        └──► 向你汇报：通道、档位、原样测试计数、顾问裁定
```

| 通道 | 模型运行方式 | 代理 | 何时用 |
|---|---|---|---|
| Agentic（默认） | `codex exec` 指向你的中转（Responses 协议），模型按你选的权限档位（`workspace` / `workspace-net` / `yolo`）自己读文件、改代码、跑测试；重试时续跑同一会话 | `codex-implementer` | 所有实现任务 |
| Chat / 备用 | `scripts/llm.mjs` 聊天补全，代理逐字应用回复 | `relay-implementer` | codex 不可用、同一任务失败两次、或想要可审计的四次调用轨迹（`PROTOCOL: four-phase`） |
| Review | Claude，继承会话档位，只读 | `llm-advisor` | 关键决策点 + 每次交付前的强制终审 |

推理档位**按任务**写在 spec 里（`REASONING: low|medium|high|xhigh`），不做全局钉死。

## 依赖

- Claude Code ≥ 2.1.x
- Node ≥ 18
- 一个 OpenAI 兼容中转：base URL + API key（需要 `/v1/chat/completions`；如要用 agentic 通道还需 `/v1/responses`）
- 可选，agentic 通道需要：[OpenAI Codex CLI](https://github.com/openai/codex) ≥ 0.155（`npm i -g @openai/codex@latest`）。不需要 `codex login`，通道脚本会把 codex 指向你的中转。
- Windows：Git Bash（随 Git for Windows 安装）

## 安装

**从 GitHub 安装（推荐）：**

```
claude plugin marketplace add ypyik0669/delegating-to-external-llm
claude plugin install delegating-to-external-llm@delegating-to-external-llm
```

**或 clone 到 skills 目录**（原地自动识别为 `delegating-to-external-llm@skills-dir`，改文件即时生效）：

```
git clone https://github.com/ypyik0669/delegating-to-external-llm ~/.claude/skills/delegating-to-external-llm
```

**或临时加载：** `claude --plugin-dir /path/to/delegating-to-external-llm`

重启 Claude Code。`/plugin list` 能看到插件，`/agents` 能看到 `codex-implementer`、`relay-implementer`、`llm-advisor`。

## 配置：你的中转和 key

**在你自己的终端**运行交互式配置（key 输入时不回显，写入 `~/.claude/llm-relay.env`，权限 600，永远不会粘贴到聊天里）：

```
node ~/.claude/skills/delegating-to-external-llm/scripts/setup.mjs
```

会依次询问：

| 提示 | 含义 |
|---|---|
| Relay base URL | 例如 `https://relay.example.com`（不带 `/v1`） |
| API key | 不回显 |
| Model | 默认 `gpt-6-astra`，可填你中转支持的任意模型名 |
| Default reasoning effort | `low|medium|high|xhigh`，spec 未写 `REASONING:` 时的默认值 |
| Minimum input tokens | 一般填 `0`；若你的中转拒绝小请求（如"不接受少于 2000 token"），填 `2000`，`llm.mjs` 会自动填充短提示 |
| codex permission level | `workspace`（只能写仓库内、无网络，默认）、`workspace-net`（仓库 + 网络）、`yolo`（无沙箱、不弹确认，模型能做你账号能做的一切） |

随后自动冒烟测试中转，并报告是否检测到 codex。非交互方式：

```
node scripts/setup.mjs --base https://relay.example.com --key sk-... --model gpt-6-astra --reasoning xhigh --min-input 0 --codex-access workspace
```

在 Claude Code 内也可以用 `/delegating-to-external-llm:setup` 走同样流程（`--check` 只做复验）。

最后，为了让规则在上下文压缩后仍然生效，在 `~/.claude/CLAUDE.md` 加一行：

```
When delegation to the external LLM is active (the user said the external model must do the coding, or "you are only the brain"), use the delegating-to-external-llm:delegating-to-external-llm skill for every coding task, including after context compaction.
```

## 使用

对 Claude 说：

> 把所有编码交给外部模型做；你只是大脑。

Claude 会加载 skill，为每个任务写六段式 spec，把互不相交的文件集派给通道（相互独立的任务并行），读 diff、重跑或抽查验证命令，咨询 `llm-advisor`，然后汇报。

### spec 合同（`templates/spec.md`）

```
OBJECTIVE:     要做什么，一段话
FILES:         精确路径（并行通道之间不相交）
INTERFACES:    需要匹配的签名 / 类型 / API 形状
CONSTRAINTS:   项目约定、不能动的东西、Windows 上的 CRLF 提醒
VERIFICATION:  精确的验证命令 + 期望结果
REASONING:     low | medium | high | xhigh
MODEL:         可选覆盖
PROTOCOL:      four-phase   （可选，chat 通道：分析 → 失败测试 → 实现 → 自审）
```

spec 里出现代码，就说明这个任务还没真正委托出去。通道会先跑 `scripts/spec-lint.mjs`，不完整的 spec（缺段、`REASONING` 非法、`FILES` 用通配符、代码围栏超过 15 行）直接拒绝。

### 通道报告

每个通道返回：

```
LANE REPORT
LANE: codex-implementer (gpt-6-astra via relay, effort: high)
STATUS: complete | partial | timeout | unavailable | refused
OBJECTIVE / CHANGES / VERIFIED（通道自己重跑，计数原样）/ MODEL SAID / ROUNDS / JUDGMENT CALLS / GAPS / REASON
```

空 diff 一律是 `refused`，绝不算 `complete`。CLI 缺失或中转挂了是 `unavailable`。改了 spec FILES 之外的文件是 `SCOPE VIOLATION`，通道报 `partial`。任何通道都不会退回到 Claude 自己写代码。

### 并行任务：一个通道一个 worktree

```
bash scripts/lane-worktree.sh create <slug>   # 建 .lanes/<slug>，分支 lane/<slug>；路径写进 spec 的 WORKTREE:
bash scripts/lane-worktree.sh check  <slug>   # 干跑合并，列出冲突文件
bash scripts/lane-worktree.sh merge  <slug>   # 合并但不提交（由你提交），删除 worktree
bash scripts/lane-worktree.sh cleanup
```

文件集必须不相交，热点文件（路由、配置、注册表、依赖清单）只能属于一个 spec。冲突以修正后的 spec 回给通道，架构师不亲手解决。

### 用量账本

每次通道调用追加到 `~/.claude/llm-usage.jsonl`。`node scripts/usage.mjs --since 24h`（或 `/delegating-to-external-llm:usage`）按通道、状态、项目汇总调用数、prompt / cached / output token 和耗时，这就是"代码是外部模型写的、不是 Claude 写的"的证据。

## 硬性门禁（可选）

`hooks/block-direct-edits.mjs` 是插件注册的 PreToolUse 钩子。委托模式开启时，它会拦截主会话对仓库文件的 Edit / Write / NotebookEdit，除非当前项目存在新鲜的外部模型输出文件。

```
touch ~/.claude/llm-delegation.on    # 开
rm    ~/.claude/llm-delegation.on    # 关
```

详见 [hooks/README.md](hooks/README.md)。

## 降级路径

- 没有 codex → 全部走 `relay-implementer`，报告会注明。
- 中转挂了 → 两个通道都报 `unavailable`，Claude 报告阻塞，不会自己写代码。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `HTTP 400 … 少于 N 个 token` | 中转拒绝小请求。重新运行 setup 并加 `--min-input N`，`llm.mjs` 会填充短提示。 |
| `relay error in stream: … overloaded` | 中转在 200 的流里塞了错误事件。`llm.mjs` 自动重试两次，仍失败则报 `unavailable`。 |
| codex 通道 `STATUS: unavailable … 401` | `~/.claude/llm-relay.env` 里 key 或 base URL 不对。 |
| `wire_api = "chat" is no longer supported` | codex ≥ 0.155 只支持 Responses 协议；中转必须提供 `/v1/responses` 才能用 agentic 通道，否则只用 chat 通道。 |
| codex 退出 0 但什么都没改 | 这就是 `refused`。看最终消息，通常是 spec 有缺口或 `~/.codex/AGENTS.md` 里有规则；通道前言已声明对此类规则的豁免。 |
| Windows 下 codex 找不到仓库 | 通道脚本传的是 `pwd -W`；请在 Git Bash 里从仓库根目录运行。 |

## 测试与评测

```
npm test                                   # 22 个 node:test 用例：钩子、spec-lint、用量账本
npm run check                              # 所有脚本 node --check + bash -n
claude plugin eval . --tag offline --scaffold --runs 1 --no-publish   # 行为评测（见 evals/README.md）
```

CI 在 ubuntu + windows 上跑同样的检查（`.github/workflows/ci.yml`）。

## 文件

```
.claude-plugin/plugin.json, marketplace.json   清单 + marketplace 条目
skills/delegating-to-external-llm/SKILL.md     路由准则、spec 合同、报告格式、红旗清单
agents/codex-implementer.md                    agentic 通道（codex exec 走你的中转）
agents/relay-implementer.md                    chat 通道（llm.mjs，逐字应用，四阶段）
agents/llm-advisor.md                          只读 Claude 评审
commands/setup.md, commands/usage.md           /delegating-to-external-llm:setup、:usage
scripts/setup.mjs                              交互式中转 / key / 权限档位配置 + 冒烟测试
scripts/llm.mjs                                流式聊天补全 CLI（--spec、-f、--effort、--out、--pad、自动重试、记账）
scripts/codex-lane.sh                          codex exec 包装：中转 provider、权限档位、文件围栏、会话续跑、记账、ran/refused/unavailable 判定
scripts/spec-lint.mjs                          拒绝不完整或"口述实现"的 spec
scripts/lane-worktree.sh                       并行通道的 worktree create / check / merge / cleanup
scripts/usage.mjs, scripts/usage-log.mjs       用量账本
hooks/hooks.json, hooks/block-direct-edits.mjs 可选 PreToolUse 门禁
templates/spec.md, templates/four-phase.md
tests/, evals/, .github/workflows/ci.yml
llm-relay.env.example                          真实文件永远不要提交
```

## 安全说明

- 凭据只存在 `~/.claude/llm-relay.env`（权限 600），仓库的 `.gitignore` 已排除。
- 所有委托内容都会发送到你配置的中转。不要发送密钥、`.env` 文件或客户数据；skill 对通道也有同样要求。
- codex 通道按 `LLM_CODEX_ACCESS` 设定的档位运行。默认 `workspace` 是只能写仓库内、无网络的沙箱；`yolo` 完全去掉沙箱和确认提示，只在你愿意让模型以你的身份操作的机器上选它。

## 致谢

架构与准则改编自 [DannyMac180/fable-advisor](https://github.com/DannyMac180/fable-advisor)（MIT）。2.1 的防跑偏和省 token 设计参考了 2026 年关于多代理编码的研究与实践：子代理 token 倍增与范围约束（[MindStudio](https://www.mindstudio.ai/blog/claude-code-subagents-cost-tokens)）、上下文漂移与文件级围栏（[arXiv 2603.00822](https://arxiv.org/html/2603.00822v1)、[Codex KB](https://codex.danielvaughan.com/2026/06/15/agents-md-beyond-init-writing-project-instructions-that-reduce-token-spend-hooks-mcp-skills/)）、worktree 隔离与协调（[AgenticFlict](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/)、[STORM](https://arxiv.org/pdf/2605.20563)）。

## 许可证

MIT
