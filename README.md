# github-claude-channel

基于 `gh CLI` 的只读 GitHub Channels / MCP 插件：让不同客户端/session 独立订阅仓库、Actions run/workflow、Issue 和 PR 的变化。

当前已实现运行时、插件配置和三个 skills，完成本地回归、真实 GitHub Issue/PR/Actions 和参考 fork 宿主 Channels/Monitor 验收。**仍为初始验证版本，不表示官方 CLI parity、全部边界或 Marketplace 安装发布已经通过**。各项结论以对应报告的实际证据为准。

详见 [设计文档](docs/design.md)、[实施与验证状态](docs/implementation.md)、[当前插件/市场安装验收](docs/marketplace-validation.md)、[真实宿主交互验收](docs/host-validation.md)、[真实 GitHub 验收结果](docs/github-validation-results.md) 和 [自测方法](docs/github-validation.md)。各报告区分源码测试、宿主路由、真实 API 和未覆盖项。

## 当前支持

- Actions：运行结果、job/step 进度，以及 rerun attempt。
- Issue：评论、新建、关闭、重开。
- PR：普通评论、review、行内意见、新建、关闭、合并、重开、Draft 和 head SHA 变化。
- 指定对象订阅，以及仓库级新对象发现。
- session 隔离、共享采集、独立确认、断线重放；非 Channels 客户端可通过 MCP 工具拉取。
- 首版只读，不发评论、不 rerun/merge，不把 GitHub review approval 当作本地工具授权。

## 安装与启动

同一仓库同时是插件和 marketplace：仓库/package/状态目录品牌保留 `github-claude-channel`，marketplace 名为 `github-claude-channel`，插件与 MCP server 名为 `github`。在宿主内安装：

```text
/plugin marketplace add Esonhugh/github-claude-channel
/plugin install github@github-claude-channel
```

marketplace 定义位于 `.claude-plugin/marketplace.json`，条目 `source: "./"` 指向仓库根目录的插件，而不是 `.claude-plugin/` 子目录。上述是当前命名的安装入口；实际安装与宿主验收以对应版本的报告为准。

需要 Bun、已配置只读访问权限的 `gh`，以及支持 MCP 的宿主。源码加载/开发先安装依赖；运行时只有 MCP SDK 与 Zod 两项直接依赖：

```bash
bun install --frozen-lockfile
bun src/cli.ts stdio
```

stdio 是 JSON-RPC 服务，不是交互命令行。插件 manifest 为 `.claude-plugin/plugin.json`，MCP 声明为 `.mcp.json`，由支持本地插件的宿主装载；skills 文件在 `skills/`。**加载插件或 MCP 成功不会自动打开 Channels**，仍需宿主自己的频道启用/准入流程。

已安装 marketplace 插件时，使用以下开发频道入口，二进制路径换成自己的参考 fork 产物，并实际接受开发频道确认。正常 `--channels` 仍受宿主允许名单约束，不会因为该仓库也是 marketplace 就自动放行：

```bash
GHC_CHANNELS_STATE=enabled \
GHC_DELIVERY_EVIDENCE='Explicit development channel startup and local confirmation' \
  /path/to/built-claude \
  --dangerously-load-development-channels plugin:github@github-claude-channel
```

仅做本地源码开发、不走 marketplace 安装时，可从仓库根目录使用 `--plugin-dir "$PWD" --dangerously-load-development-channels server:plugin:github:github`，同样需要真实宿主确认。历史验收报告保留当时的命名与命令；当前命名已完成从真实 GitHub 添加市场、安装、reload、三个 skills 和真实评论 Channels 投递的参考宿主验收，见安装报告。官方 CLI parity 仍未验证。

所有客户端共享同一认证 profile 的 daemon；每个 stdio adapter 默认创建独立 consumer，并生成 0600 的本机恢复文件。环境变量：

| 变量 | 用途 |
| --- | --- |
| `GHC_STATE_DIR` | 状态根目录，默认 `~/.local/state/github-claude-channel` |
| `GHC_PROFILE` | 显式 profile 名；还按 gh 配置/认证环境来源隔离，不输出 token |
| `GHC_CONSUMER_FILE` | 可选私有恢复文件；同路径代表恢复同一 consumer，会 fence 原连接；不同 session 不应共用 |
| `GHC_CHANNELS_STATE` | enabled / unavailable / unknown，默认 unknown；仅依据明确宿主证据配置 |
| `GHC_MONITOR_STATE` | available / unavailable / unknown，默认 unknown |
| `GHC_DELIVERY_EVIDENCE` | 上述状态对应的明确宿主配置依据，不是探测结果 |
| `GHC_GH` | gh 可执行文件路径；自测指向 `tests/fixtures/gh.ts` |
| `GHC_ALLOWED_HOSTS` | 允许的 GitHub host，逗号分隔；默认 GH_HOST 或 github.com，避免把认证发送到描述中任意 host |

`GH_CONFIG_DIR` 和 gh 的认证环境变量照常生效。凭据不写入工具结果或日志。切换账号会暂停采集/私有读取，需重新绑定新 profile；相同账号 token 权限变更仍需操作者重启/重新绑定，不声称自动识别所有变化。

## 订阅入口

```text
/github:subscribe <描述>
/github:unsubscribe <watch-id>
/github:list
```

watch_id 由服务端成功持久化订阅后生成并返回，是一组 targets 的订阅句柄，不是 GitHub ID 或恢复凭据。当前 session 提交规范化规则完全相同的订阅，幂等返回已有 watch_id；不同 session 独立。`/subscribe` 短名取决于宿主命令解析，不保证可用。

subscribe 不设子命令，也不要求用户预先命名句柄；退订使用独立 unsubscribe skill。unsubscribe 解绑当前 consumer 的指定 watch_id 的全部 targets；不存在则幂等返回 `already_absent`，不影响其他 session 或共享 watcher 的其他订阅。

list 只列当前 consumer/session，按 watch_id 分组、分页展示目标/事件范围摘要、采集状态、最近成功采集时间和待投递数量；没有订阅时明确显示“无订阅”，不展示其他 session。

自然语言由宿主 skill 解析，结构化 MCP 工具不执行描述。示例：

```text
/github:subscribe 监听 owner/repo 的 PR #42 的 review、行内意见、关闭和合并；同时监听 owner/other 的 issue #17 评论、关闭和重开
/github:subscribe 监听 owner/repo 的 run 123456789，最新 attempt，通知 job/step 和最终结果
/github:subscribe 监听 owner/repo 新建、关闭、重开的 issue 和 PR
/github:unsubscribe watch_opaque
/github:list
```

skill 会在当前请求 session 内把自然语言转换成明确的结构化 MCP 订阅；有歧义先澄清且不创建，描述不作为 shell 执行，不通过 fork 建立订阅归属。成功后展示 watch_id 和规范化范围；replay/ack 使用内部 subscription ID，与 watch 句柄分离。

## 投递策略（用户确认）

优先使用 Channels 直接推送；只有明确确认 Channels 不可用、且宿主具备 Monitor 时，才 fallback 到 Monitor，不作为常规二选一。依据宿主明确启用/能力配置证据判断：MCP 连接成功、通知写出成功、短暂没有 ACK 或没有事件，都不能证明 Channels 已启用或失败。状态 unknown 时提示待确认，不启动双通道。

切换共用 consumer/watch、持久化 cursor 和 event_id，通过 single active delivery fencing 隔离旧通道迟到输出；仍为至少一次交付，可能重复。Monitor 到期仅标记 delivery detached，并明确提示续接，不删除 watch，也不无限自动续接。两者皆不可用时报告 `delivery unavailable`，保留 events 拉取，不能把订阅持久化成功包装成主动监听成功。

底层工具为 `subscribe`、`subscriptions`、`unsubscribe`、`snapshot`、`events`、`ack`、`delivery`。`delivery` 记录明确宿主证据，**不是自动能力检测器**。结果中的 `consumer_bridge.stream_argv` 可供宿主真正的 Monitor 工具启动事件流（含私有文件路径，不含 secret）。该流不是独立 gh 轮询，也不冒充 MCP/宿主 task：

```bash
bun src/cli.ts stream --consumer-file /private/path/consumer.json --duration-ms 300000
```

只有 Channels 明确 unavailable 且 Monitor 明确 available，流才允许 attach。默认 5 分钟，可配置至多 30 分钟；宿主 Monitor 自己的较小 cap 仍必须遵守。到期打印 detached 提示，watch 保留。处理完成后按 delivery reference 调用 ack；通知写出不会自动确认。

## 运行维护与自测

```bash
bun src/cli.ts status
bun src/cli.ts clean   # 当前 profile 到期事件/缓存清理，不清理仍在保留期的数据
bun src/cli.ts stop    # 停止当前 profile daemon，会断开该 profile 的其他 session
bun test
bun run typecheck
bun run build
```

stop/clean 是本机私有 Unix socket 管理操作，不调用 GitHub 写 API。adapter EOF 和信号关闭连接；daemon 默认无消费者活动 5 分钟退出。固定 attempt 只有在所请求 job/step 已完整采集、全部终态且连续两次最终核对一致后停止查询；latest 在确认后低频核对 rerun。终端/脚本异常退出可能遗留旧 socket，启动失败会报告路径，不自动删除未知 socket。

`bun run typecheck` 使用本地 devDependencies 中的 TypeScript 与 @types/bun，直接执行 `tsc --noEmit`，不依赖外部仓库、全局 tsc 或环境变量；`bun install --frozen-lockfile` 会安装完整开发工具链。运行时仍只有 MCP SDK 和 Zod 两项直接依赖，构建使用 Bun 内置能力。保留 Bun 的 SDK/SQLite/stdio 实现，不为减少声明类型依赖而重写为 Python/uv 或维护第二套实现。测试只用 fake gh，不要求 GitHub token；构建输出 `dist/cli.js` 也可用 `GHC_TEST_ENTRY=dist/cli.js bun test tests/integration.test.ts` 做同一组子进程验证。测试证据及资源回收记录在 `docs/evidence/`。

需要精简部署时，可以在构建机执行 `bun run build`，将约 0.59 MB 的 `dist/cli.js` 单独部署，在运行机使用 `bun /path/to/cli.js stdio`。已验证无 `node_modules` 的独立目录可以完成 MCP 握手和工具列举；运行机仍需要 Bun 和 gh。开发依赖及传递依赖没有因此消失，只是不必随打包文件部署；当前不发布预构建 release。

回归时可设置 `GHC_EVIDENCE_DIR` 指向新的测试证据目录，隔离本轮资源记录，避免改写已有历史日志；这是测试输出选项，不改变插件状态目录。

## 边界

纯轮询不能保证捕获每次瞬时源端变化；Channels 通知写出不等于模型已处理。本设计只对已采集并持久化的事件提供重放与至少一次投递，不承诺 exactly-once，也不承诺所有 MCP 客户端能自动接收 Channels 推送。
