# Claude 宿主交互验收

命名说明：本页保留重命名前插件 `github-claude-channel` 的实际输入、工具名和原始证据；最终插件名称已改为 `github`，仓库/市场名仍为 `github-claude-channel`。不要把下列历史命令当成当前安装入口，也不要改写历史 pane 来伪装新名称已经验收。

日期：2026-11-17（UTC）。第一轮使用模拟 GitHub 验证真实 CLI 的插件装载、skill dispatch、MCP 工具调用和通知投递；后续另有真实 GitHub Issue 评论到同一 CLI 的端到端验证。模型始终为确定性 loopback fixture，不将其冒充真实模型语言理解测试。完整 Issue/PR/Actions 远端矩阵另外由 `scripts/github-smoke.ts` 验证。

## 范围与制品

- 本轮在参考仓库执行 `make build` 成功；宿主版本 `2.1.297`。
- 二进制 SHA-256：`a23e4ce1e0d301ca4d2cc691e30100628ee603a7ea6e1431b148ba064de36145`。
- 终端：工具管理的 tmux pane `term-2`，160 × 45；PID、flags 和原始证据绝对路径见 [validation.json](evidence/host-20261117/validation.json)。
- 独立 HOME、配置、工作目录和 consumer 状态；未使用真实模型凭据。
- `scripts/host-fixture-provider.ts` 提供 loopback SSE 确定性工具调用，`tests/fixtures/gh.ts` 提供可重复数据变化。
- 所有命令均发送到实际 CLI stdin，不通过父 assistant 的 Skill/Monitor 工具代替被测宿主行为。

## 断言与结果

| ID | 入口 / 断言 | 证据 | Runtime | Verdict |
| --- | --- | --- | --- | --- |
| list | `/github-claude-channel:list` 实际调用 subscriptions，返回空列表 | [pane](evidence/host-20261117/01-list-pane.txt) | done | passed |
| subscribe | `/github-claude-channel:subscribe 监听 o/r issue #1 的评论、关闭和重开` 调用结构化 subscribe 并返回 watch ID | [pane](evidence/host-20261117/02-subscribe-pane.txt) | done | passed |
| channels | 显式开发频道确认后，新增评论经 `notifications/claude/channel` 进入同一宿主会话 | [pane](evidence/host-20261117/03-channel-pane.txt)、[markers](evidence/host-20261117/debug-markers.txt) | done | passed |
| monitor | 明确设为 Channels unavailable，实际宿主调用 Monitor 消费同一 consumer 事件流；观察到未确认事件重放和一条新事件 | [pane](evidence/host-20261117/04-monitor-pane.txt) | done | passed |
| detached | stream 自然结束后，list 仍有一个 watch，delivery 为 monitor/detached | [pane](evidence/host-20261117/05-detached-pane.txt)、[工具结果](evidence/host-20261117/provider-records.json) | done | passed |
| unsubscribe | `/github-claude-channel:unsubscribe <返回的ID>` 退订，再查询返回 `无订阅` | [pane](evidence/host-20261117/06-unsubscribe-pane.txt)、工具结果 | done | passed |
| cleanup | 已知宿主/provider PID 退出，私有 socket 不再存在，consumer 私有状态回收 | validation.json | done | passed |

Channels 到 Monitor 切换是受控、明确的配置变更，不是因静默或缺少 ACK 推断 Channels 失效。重放沿用原 event ID，符合至少一次交付；本次模型 fixture 没有 ACK 旧事件，因此重放不是双通道同时投递的证明。

## 限制与失败保留

- `not covered`：真实模型对自然语言的理解、自动宿主能力发现、官方 CLI parity、显式 TaskStop（本次 stream 自然结束）。本报告不将确定性工具调用视为语言理解测试。
- `not covered`：在同一个宿主会话中使用真实 GitHub 的所有事件类别。下节已证明实际 Issue 评论经两种通道到达宿主，但没有将 SDK 层的 PR/Actions 矩阵冒称为同一次 CLI 运行。
- 首轮 `term-1` 未纳入通过证据：参考 launcher 丢弃附加频道参数，且模型 fixture 初版未处理 deferred ToolSearch。随后采用新的独立配置和启动脚本重试；没有拼接首轮的成功片段。
- 欢迎页曾显示频道名称未配置，但随后连接 debug 明确注册 handler，实际事件已到达。该参考宿主的展示现象不作为本插件推送失败或自动检测依据。
- 本轮没有修改参考 Claude 仓库源码；该仓库原有三个未提交源码改动保持原样。

## 依赖与部署补充

从公开仓库全新 clone 后，冻结安装、`bun run typecheck`、`bun run build`、`bun test` 均通过：29 tests，0 failed。`bun build` 产物约 0.59 MB；将其复制到无 `node_modules` 的独立临时目录后，真实 MCP initialize/tools/list 成功，包含全部 7 个工具。

因此可以由开发/构建环境安装依赖，部署环境仅保留 Bun、gh 和打包后的 JS。不能将“两项直接运行时依赖”说成“没有传递依赖”；目前没有发布预构建制品，也没有为了 uv 维护第二套 Python 实现。

另外，从公开仓库再次全新 clone 后，未先执行 `bun install` 的源代码入口也完成了 MCP initialize/tools/list（7 个工具），验证了当前 Bun 的自动依赖解析路径。仍推荐冻结安装用于可复现开发/构建；该探针不保证所有 Bun 版本或离线缓存状态。

## 真实 GitHub → 同一宿主的补充验收

独立重试会话 `term-4`（160 × 45），使用同一轮构建二进制、本地模型 fixture，但数据源改为真正的 gh/GitHub API，30 秒轮询、显式 `HTTPS_PROXY=http://127.0.0.1:7890`。仅 gh 子进程映射已有认证 HOME；Claude 的 HOME/config/state 仍隔离，没有复制或打印凭据值。

| 断言 | 真实来源与观察 | Verdict |
| --- | --- | --- |
| 订阅 | 实际 `/github-claude-channel:subscribe` 为 `Esonhugh/github-claude-channel#3` 返回 watch ID | passed |
| Channels | 新评论 `6954240894` → `evt_996bc901aada32f121d86b40353004e9d398f7b3165fde28dd2766994ea2df4c`，实际终端出现 Channels 消息 | passed |
| 切换 | 宿主 ACK seq=1 后显式停用 Channels lease，再调用真实 Monitor `b1l1btj2p` | passed |
| Monitor | 新评论 `6954292191` → `evt_0c2129c3df3d5fdd752e64dd9fc29b43b46cbbd7b10ec5f2b3a02aa0cf224379`，实际 Monitor event 携带 seq=2；不是旧事件重放 | passed |
| 退出与退订 | stream 自然结束，watch 保留且 detached；读取 events 核对 source_id 并 ACK seq=2；随后 skill 退订，列表为空 | passed |
| 收尾 | Issue #3 关闭、宿主正常退出、已知 PID 和 socket 均不存在，consumer 私有状态回收 | passed |

原始证据见 [validation.json](evidence/host-live-20261117/validation.json)、[provider/tool records](evidence/host-live-20261117/provider-records.json)、[channel pane](evidence/host-live-20261117/02-channel-pane.txt)、[monitor pane](evidence/host-live-20261117/03-monitor-pane.txt) 和 [debug markers](evidence/host-live-20261117/debug-markers.txt)。事件通过同一 consumer 的 events 工具与 GitHub `comment:<id>` 对照，未混用另一轮会话的数据。

认证环境首轮 `term-3` 返回 `/user` HTTP 401。保留 [失败 pane](evidence/host-live-20261117/00-auth-isolation-failure-pane.txt)；受控对照发现原 gh HOME 能认证、隔离 HOME 加 GH_CONFIG_DIR 覆盖不能认证，因此新建隔离会话，仅对 gh 映射原 HOME 后重试。该问题属于验收认证 fixture 边界，不将其当成 GitHub 服务不可用，也没有绕过身份核对。失败与成功证据不拼接。
