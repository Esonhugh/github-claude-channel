# 真实 GitHub 验收结果

命名说明：这轮数据源/传输验收运行于插件重命名前；原始工具记录中的 `github-claude-channel` 不改写。最终插件名为 `github`，仓库和独立市场仍名为 `github-claude-channel`，新的安装入口另外验收。

日期：2026-11-17（UTC）。目标固定为公开仓库 `Esonhugh/github-claude-channel`，操作者已明确授权在该仓库创建测试对象、提交/push、触发 workflow 和评论/关闭/重开。不涉及其他仓库的写操作，也不表示 Marketplace 已发布。

## 命令与范围

```bash
HTTPS_PROXY=http://127.0.0.1:7890 bun scripts/github-smoke.ts --allow-writes \
  --pr 1 --workflow channel-validation.yml \
  --ref validation/channel-events-20261117 \
  --case-timeout-seconds 300 --total-timeout-seconds 1800
```

本轮真实 API 与 daemon 采集轮询间隔 30 秒，进程显式使用 loopback 代理。两个 MCP SDK stdio clients 共享隔离 daemon，使用独立 consumer 身份；没有模型调用。

原始断言、API 输入/输出摘要、事件、通知和进程回收证据：

- [report.json](evidence/github-2026-11-17T16-15-54-602Z-78405/report.json)
- [gh.json](evidence/github-2026-11-17T16-15-54-602Z-78405/gh.json)
- [events.json](evidence/github-2026-11-17T16-15-54-602Z-78405/events.json)
- [notifications.json](evidence/github-2026-11-17T16-15-54-602Z-78405/notifications.json)

## 结果

脚本退出码 0，**19 passed / 0 failed / 3 not covered**。其中 `not covered` 分别是可选的预先指定 run 输入、宿主二进制（由单独宿主报告验收）、真实 PR 新建/合并事件。没有将未执行项计为通过。

| 范围 | 实际观察 | Verdict |
| --- | --- | --- |
| 仓库发现 | 已建立订阅后，新建测试 Issue 产生 opened 事件 | passed |
| Issue | 新评论、评论编辑、关闭、重开 | passed |
| session 隔离 | 相同规则重试幂等；A ACK 不推进 B；A 退订不影响 B | passed |
| Channels 协议 | 实际 GitHub 变更产生 SDK channel notification，带对应 event ID | passed |
| Monitor CLI | 显式 fallback 后事件经 consumer-bound stream 输出；不是独立 gh 轮询 | passed |
| PR | 普通评论、COMMENT review、行内评论、关闭、重开 | passed |
| Actions success | 实际运行完成，产生 terminal run/job/step 事件及 channel notification | passed |
| Actions failure | 故意失败运行完成，failure 结果及 job/step 终态正确投递 | passed |
| 资源回收 | 已记录 daemon、adapter、stream、gh PID 全部退出，remaining_pids=[] | passed |

测试对象：

- `Esonhugh/github-claude-channel#1`：PR fixture，验收后关闭但未合并；保留分支 `validation/channel-events-20261117` 和评论作为证据。
- `Esonhugh/github-claude-channel#2`：脚本自动创建的 Issue，验收后关闭。
- [成功运行](https://github.com/Esonhugh/github-claude-channel/actions/runs/44125363066)
- [故意失败运行](https://github.com/Esonhugh/github-claude-channel/actions/runs/44125966878)：这是 failure 通知 fixture，不是产品测试失败。
- 首次 push 的 [常规 CI](https://github.com/Esonhugh/github-claude-channel/actions/runs/44123533275) 成功。

## 覆盖边界

- 本报告只证明实际 GitHub → gh → daemon → MCP SDK/CLI stream。实际 Claude 宿主、skill dispatch 和 Monitor task 的证据见 [宿主报告](host-validation.md)，不得把 SDK 测试冒充宿主测试。
- 真正 merge、快速 close/reopen 的完整历史补偿、GitHub 真实 rerun、企业 GitHub、多机器、官方 CLI parity 尚未在本轮远端矩阵执行。相关模拟回归存在，不等同于真实远端证据。
- 不发布 release、tag 或预构建制品；Marketplace 安装发布仍为独立步骤。
