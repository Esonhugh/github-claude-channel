# `github` 插件 / 同仓库 Marketplace 验收

日期：2026-11-17（UTC）。当前命名：插件与 MCP server 为 **github**，独立市场及仓库为 **github-claude-channel**。本页验证新命名及实际安装；旧名称下的数据源、Monitor 等证据保留在其他报告，不改写历史记录。

## 被测配置与入口

- 代码提交：`747ceede4b5136fe5046b15a7051f10bcae1a29e`。
- `.claude-plugin/plugin.json`：`name: github`。
- `.claude-plugin/marketplace.json`：`name: github-claude-channel`；`plugins[0].name: github`；`source: ./` 指向仓库根目录。
- `.mcp.json`：server key `github`，执行根目录 `src/cli.ts stdio`。
- 参考 fork 本轮构建 `2.1.297`；二进制 SHA-256 `a23e4ce1e0d301ca4d2cc691e30100628ee603a7ea6e1431b148ba064de36145`。
- Tmux 工具驱动真实 CLI stdin，未使用父 assistant 的 Skill/MCP 调用替代宿主行为。模型是 loopback 确定性 fixture，不是自然语言理解评估。

实际执行，没有使用 `--plugin-dir` 代替安装：

```text
/plugin marketplace add Esonhugh/github-claude-channel
/plugin install github@github-claude-channel
/reload-plugins
/github:list
```

安装使用隔离 HOME/config 的 user scope，未修改日常配置。GitHub HTTPS 访问显式设置 loopback 代理。后续启动已安装插件时，使用真实开发频道确认：

```text
--dangerously-load-development-channels plugin:github@github-claude-channel
```

这不是普通允许名单授权，不表示安装市场会自动放行 Channels。

## 断言与证据

| ID | Predicate / 必要证据 | 实际证据 | Runtime | Verdict |
| --- | --- | --- | --- | --- |
| market-add | 真实 GitHub clone 后读取自身 marketplace | [add pane](evidence/marketplace-github-20261117/01-marketplace-add-pane.txt)、install debug markers | done | passed |
| install | 从 `source: ./` 安装根插件 github，版本 0.1.0 | [install pane](evidence/marketplace-github-20261117/02-install-pane.txt) | done | passed |
| reload-list | reload 发现 3 skills / 1 plugin MCP；`/github:list` 调用 `plugin:github:github` subscriptions | [reload/list pane](evidence/marketplace-github-20261117/03-reload-list-pane.txt) | done | passed |
| artifact | 安装缓存中 manifest、MCP 配置、CLI 与 3 skills 的内容 hash 与当前源代码一致 | [validation.json](evidence/marketplace-github-20261117/validation.json) 的 7 个内容 hash | done | passed |
| subscribe | 已安装版本 `/github:subscribe` 持久化并返回 watch ID；明确只订阅 comments | [subscribe pane](evidence/marketplace-github-20261117/05-subscribe-pane.txt) | done | passed |
| channel | 真实评论 `6955197964` 经安装版本的 Channels handler 进入宿主 | [channel pane](evidence/marketplace-github-20261117/06-real-channel-pane.txt)、final provider records 与 debug markers | done | passed |
| unsubscribe | `/github:unsubscribe` 后订阅列表为空 | [unsubscribe pane](evidence/marketplace-github-20261117/07-unsubscribe-pane.txt) | done | passed |
| cleanup | 已知 PID 退出，准确 `/tmp` socket 路径不存在，安装缓存入口的 adapter/daemon/wrapper 无残留；私有 consumer 状态回收 | validation.json | done | passed |

真实事件：`Esonhugh/github-claude-channel#3` 的 `comment:6955197964`，对应 `evt_1b597d54ad5e5ac2f66bad71136711be9ea5db81c06ad9cde7b324b74fe2aaf4`、seq=1；宿主再通过 events 核对来源并 ACK。该 Issue 保持关闭作为测试证据，不合并任何 PR。

完整路由证据见 [install markers](evidence/marketplace-github-20261117/install-debug.log-markers.txt)、[final markers](evidence/marketplace-github-20261117/final-debug-channel.log-markers.txt) 和 [final tool records](evidence/marketplace-github-20261117/final-provider-records.jsonl)。

## 认证 fixture 失败与隔离重试

首次已安装版本订阅返回 `gh_failed`。受控 wrapper 诊断证明 gh 在继承隔离的 `XDG_CONFIG_HOME` 后退出码为 4、要求登录；只改 HOME 不足以映射原有认证来源。修正 gh-only 的 HOME/XDG 认证映射后，在实际 MCP 隔离环境下 `/user` 对照返回 HTTP 200。

随后新建 HOME/config/state，复用内容 hash 已核对的安装产物，在 `term-8` 独立验证。失败的 `term-7` [pane](evidence/marketplace-github-20261117/04-auth-fixture-failure-pane.txt) 与脱敏 gh 诊断保留，不把失败 slash command 算作通过，也不混用其事件。插件采集代码没有因该 fixture 问题改变，没有复制或打印实际认证值。

另一次尝试以本地路径注册保留名称 `Esonhugh-Marketplace` 被参考宿主来源策略拒绝；未修改允许名单或伪造来源。最终直接从实际 GitHub 仓库添加其自己的市场，按正常来源检查完成安装。独立市场的验证不等于已 push 外部 `Esonhugh/Marketplace`。

## 自动化与剩余边界

- 新命名配置合约先红后绿；[命名回归证据](evidence/plugin-github-naming-alpiqvr7/validation.json)：**31 pass / 0 fail**，本地 typecheck/build 成功，打包入口 **10 pass / 0 fail**。父侧独立重跑得到相同通过数量。
- [GitHub CI](https://github.com/Esonhugh/github-claude-channel/actions/runs/44131491621) 对代码提交 `747ceed` 成功。
- `not covered`：官方 CLI parity、真实模型语言理解、多机器/GHES、未执行的真实 merge/rerun、显式宿主 Monitor TaskStop。Monitor 的实际宿主/真实 GitHub fallback 证据来自重命名前的独立验收；当前命名的同一路径另有自动化覆盖，没有冒称再次跑过全部远端矩阵。
- 外部 `Esonhugh/Marketplace` 的本地条目已指向同一仓库的 github 根插件，但未提交/push；没有发布 tag/release 或预构建制品。
