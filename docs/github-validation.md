# 真实 GitHub 黑盒验收

`scripts/github-smoke.ts` 使用两个真实 MCP SDK stdio clients、一个隔离 daemon、真实 `gh api` 和实际 CLI stream 验证插件，不调用模型。本文件描述可执行方案，**不表示远端验收已经运行或通过**。

## 范围与权限

- 仓库硬编码为 `Esonhugh/github-claude-channel`，不能通过参数指向其他仓库。
- 必须显式传 `--allow-writes`：脚本会创建/编辑测试评论、关闭/重开所选 Issue/PR；未传 `--issue` 时创建带 `[channel smoke]` 标记的 Issue，结束时关闭、不删除。已有 Issue/PR 的 open/closed 状态在 finally 恢复，测试评论保留。
- `--workflow` 会 dispatch 两次测试运行，分别要求 success/failure；不会修改 workflow、push、创建/合并 PR、删分支或取消运行。协调方负责 workflow、PR fixture、commit/push 和宿主 tmux 验证。
- `gh`、daemon 和 adapter 都显式注入 `HTTPS_PROXY=http://127.0.0.1:7890` 及对应小写/HTTP 变量。保留现有 gh 认证来源，不打印 token、不复制凭据。无需给脚本提供 token 参数。
- 复用同一 OS 用户的 gh 权限。运行前确认 `gh` 已登录、代理已启动、仓库具有 Issues 写权限；PR/review 与 workflow dispatch 还需要对应 GitHub 权限。

## 命令

在本仓库先安装已批准依赖：

```bash
bun install --frozen-lockfile
bun scripts/github-smoke.ts --help
```

最小真实验收：自动创建一个测试 Issue，覆盖 repository opened、评论/编辑、close/reopen、session 隔离、退订和两种传输：

```bash
bun scripts/github-smoke.ts --allow-writes
```

完整示例（编号和分支必须替换为协调方准备的本仓库 fixture）：

```bash
bun scripts/github-smoke.ts --allow-writes \
  --pr 12 \
  --workflow channel-smoke.yml --ref smoke-fixtures \
  --case-timeout-seconds 240 --total-timeout-seconds 1200
```

还可指定已有 Issue、一个或多个 run：

```bash
bun scripts/github-smoke.ts --allow-writes --issue 10 --pr 12 --run 123456789
```

不传 `--issue` 最容易验证 repository 新建发现；传已有 Issue 时对应 opened assertion 为 `not covered`。run 编号应使用 `run_id`，不是 workflow ID 或网页展示序号。已有 run 在订阅前完成时，只验证真实 snapshot，变化通知标记 `not covered`，不会靠重复发送已完成状态声称通过。

## Workflow fixture 合约

协调方应在给定 ref 上准备可 `workflow_dispatch` 的测试 workflow，且该 workflow 已在默认分支登记。脚本要求：

- inputs `outcome`：接受 `success` / `failure`；inputs `marker`：string。
- `run-name` 包含 `${{ inputs.marker }}`，脚本据此唯一关联新 run，避免把其他并发运行当作自己的 fixture。
- 至少两个有名称的 step；建议首个可见 step 等待 90 秒，后续等待 35 秒后根据 `outcome` 正常退出或 `exit 1`。每轮真实 API 采集至少 30 秒，极短运行不能证明 step 变化通知。
- 不需要 secrets、checkout 或写入权限，使用最小 `permissions: {}` 即可。不要测试真实部署、发布或破坏性操作。
- 脚本串行 dispatch success 和 failure；只在 SDK 客户端建立订阅后观察到 run completion、job/step terminal changes 及对应 channel notification 时，才将该 dispatch assertion 标为 `passed`。

脚本不创建此 workflow。缺少 `--workflow/--ref` 时两种 dispatch assertion 为 `not covered`。dispatch 后若 run 在 baseline 前结束，也明确标记未覆盖变化测试，需要延长 fixture，而不是虚构事件。

## PR fixture 合约

- 显式 `--pr NUMBER` 必须是本仓库未合并的可丢弃 PR，建议保持 open，并包含一个小文本文件的新增行。
- 脚本发布普通 conversation comment、`COMMENT` review（不做 APPROVE / REQUEST_CHANGES）、一条 RIGHT-side 行内评论，然后 close/reopen。
- 首 100 个 files 中没有可评论的 added line 时，行内测试为 `not covered`；不随意选择仓库中其他文件或伪造 diff position。
- GitHub 对当前身份明确拒绝 review（403，或明确 self-review 的 422）时 review 为 `not covered`；其他错误为 `failed`，不把所有 422 当作平台限制。
- PR 创建/合并事件不在脚本自动操作范围，报告单独标记 `not covered`。协调方可在宿主真实交互验收中验证这些事件。

## Assertions 与传输语义

1. 两个独立 MCP clients 共享**本次创建的** daemon PID，分别使用私有 consumer 文件；返回不同 watch ID；同 client 相同规则幂等返回原 ID。
2. A 不能读取 B 的 subscription；A ACK 不推进 B；A 退订后 B 仍收到后续新评论；重复退订 `already_absent`。
3. A 显式注册 `notifications/claude/channel` receiver，使用带 **SDK test host evidence** 的 delivery 配置；实际收到匹配 event ID 才算 channel transport assertion 通过。
4. B 先不启用推送，之后显式测试 channel → monitor 配置切换，通过返回的 `consumer_bridge.stream_argv` 启动 60 秒 CLI stream；匹配新的真实评论 event ID，检查无相同 channel 双投；到期退出、delivery detached、watch 保留。
5. Comment edit 用实际 ID 和编辑后内容匹配；close/reopen 分开等待，以免快照轮询遗漏中间状态。原始事件的 seq、event ID、source ID、时间、source/snapshot evidence 和数据摘要保存到证据。
6. 全部真实外部轮询间隔 ≥30 秒，daemon 的 endpoint 请求串行；多端点同一轮采集不是每个端点各等待 30 秒。脚本自己的 fixture 写操作顺序执行。MCP 本地握手、进程就绪和 socket 清理检查不受远端轮询间隔约束。
7. 每个等待有 case deadline，整体有 total deadline，单次 gh 请求最多 30 秒。失败不继续制造后续 fixture；finally 尽力恢复状态、退订、关闭客户端与本次进程。

**不能混淆证据层级：**本脚本证明真实 GitHub → daemon → MCP SDK receiver / CLI stdout 的路径；不是 Claude binary 的 Channels 准入、真实 `Monitor` task、TaskStop、slash skill 派发或 tmux UI 证据。这些始终单列 `not covered`，由协调方验证。

## 证据与退出码

每次执行写入 `docs/evidence/github-<UTC timestamp>-<PID>/`：

| 文件 | 内容 |
| --- | --- |
| `report.json` | 固定仓库、非敏感输入、proxy、轮询间隔、逐项 `passed / failed / not covered`、PID/socket 和私有文件回收结果 |
| `gh.json` | 脚本自身真实 gh 的 argv、JSON stdin（只有本次测试内容）、HTTP status/exit code、原始输出 SHA-256/字节数及白名单摘要；不保存原始 header、token 或其他评论全文 |
| `events.json` | 被断言的真实事件及必要定位字段；评论内容用摘要 hash/长度代替 |
| `notifications.json` | 两个 SDK clients 实际收到的 metadata、内容 hash 和接收时间 |
| `process-output-digests.json` | daemon/adapter/CLI stderr/stdout 的长度和 hash，不把可能含本机认证诊断的原文公开 |

`gh.json` 记录测试驱动器的真实写入/查询，不是假装完整抓取 daemon 内部 gh 的每次请求。daemon 的读取由独立进程执行，其结果通过 MCP snapshot/events 黑盒验证。

退出码 1 表示至少一个 assertion 或 cleanup `failed`。退出码 0 表示已执行 assertions 没有失败，**不等于全部能力通过**：必须阅读 `not covered` 项，尤其可选 PR/run/workflow 和宿主 binary 证据。脚本不自动 commit/push 证据。

正常结束删除本次 mkdtemp 目录内 consumer secret、SQLite、私有文件并回收 owned socket。测试 Issue/评论保留；脚本不删除远端对象。清理前记录当时 daemon/adapter 的在途子进程，检查包括 daemon 自身 gh 子进程在内的已知 PID 均已退出。如进程未退出，保留隔离目录并报告失败，避免在仍运行时删除凭据/DB。SIGINT/SIGTERM 请求在当前有界操作后进入 finally；SIGKILL 或宿主崩溃无法保证 finally，被外部强制终止时需依据已创建 fixture 和进程标识人工核对。

## 未运行声明

本轮只新增脚本和本说明，允许执行 `--help`、本地语法/类型检查；不创建远端 fixture、不启动真实 smoke、不把编译成功当成 GitHub 验收。

API 合约参考：[Issue comments](https://docs.github.com/en/rest/issues/comments)、[Issues](https://docs.github.com/en/rest/issues/issues)、[Pull request reviews](https://docs.github.com/en/rest/pulls/reviews)、[Review comments](https://docs.github.com/en/rest/pulls/comments)、[Workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)。
