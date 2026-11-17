# 实施与验证状态

日期：2026-11-17。本仓库运行时由 Bun/TypeScript、内置 SQLite、MCP SDK 和 Zod 构成；没有模型 API 调用、GitHub 写工具或 permission relay。本地自测使用可重复 fake gh，真实 GitHub 与宿主装载/Channels/Monitor 验收由协调方负责，不能把本页自测当作那部分验收。

## 当前实现

| 范围 | 状态与入口 |
| --- | --- |
| 插件与 marketplace | 同仓库双用途；marketplace github-claude-channel 通过 source ./ 指向根插件 github；源代码加载需要先 bun install |
| Skills | /github:subscribe、/github:unsubscribe、/github:list，当前 session 内执行，无 context:fork，无旧子命令 |
| MCP stdio | `bun src/cli.ts stdio`，server name/key 为 github，7 个结构化工具及 claude/channel 协议不变，不声明 permission capability |
| 共享采集 | 同一认证 profile 一个 Unix socket daemon；多个 adapter、每个独立 consumer；CLI/adapter 自动发现或启动 daemon |
| 恢复 | 随机 consumer secret 只写 0600 文件，DB 保存 hash；epoch fence 旧连接，恢复不依赖 clientInfo、watch_id 或宿主 conversation ID |
| 持久化 | SQLite WAL、短事务，schema user_version=1；初始 schema 的 oldest_seq 列支持幂等迁移 |
| 订阅 | 服务器提交成功后返回 watch_id；按 target identity 合并事件类别后去重；当前 consumer 规范化完整规则相同则幂等；全部 targets 初始化成功才激活新 watch |
| 列表/取消 | 当前 consumer 按 watch 分组分页，退订幂等，不影响其他 consumer；snapshot/events/ack 均验证归属 |
| Actions | run、workflow、fixed/latest attempt、jobs、steps；保留原始 status/conclusion，latest 终态低频核对重跑 |
| Issue / PR | 生命周期、普通评论、PR review/summary 编辑、行内意见；PR merged 与普通 closed 区分，draft/head 变化 |
| Repository | state=all 的 Issue/PR 新建发现与更新核对，区分 pull_request；PR 详情 hydrate；since 重叠窗口 |
| 重放与 ack | 稳定 event_id、每 subscription delivery sequence/ack；写通知不 ack，连接恢复重新提供未确认事件；超过保留窗口显式 gap |
| 投递 | Channels 优先；明确不可用且宿主明确有 Monitor 才允许 CLI stream attach；unknown、不支持、detached 单独展示 |
| 清理 | CLI status/stop/clean，7 天事件保留，24 小时未连接 consumer 到期，默认空闲 5 分钟退出；clean 不删除仍保留的事件 |

## 给外部黑盒验证者的启动合约

仓库/package/状态目录品牌及 marketplace 名保持 `github-claude-channel`，只有 plugin 与 MCP server 名改为 `github`。安装入口：

```text
/plugin marketplace add Esonhugh/github-claude-channel
/plugin install github@github-claude-channel
```

安装后优先使用 `--dangerously-load-development-channels plugin:github@github-claude-channel` 并完成宿主确认；仅本地源码开发使用 `--plugin-dir "$PWD" --dangerously-load-development-channels server:plugin:github:github`。正常 `--channels` 仍受允许名单约束；本次命名与双用途配置回归不替代真实 marketplace 安装验收。

marketplace owner 必须是含 name 的对象，`source: "./"` 相对于 marketplace 根目录而非 `.claude-plugin/`；已核对参考 fork `src/utils/plugins/schemas.ts:269`、`:1164`、`:1448` 的 owner/source/marketplace schema。配置合约测试检查根路径、名称、版本和技能引用；MCP 子进程测试检查 initialize 返回的 server name。历史 evidence、真实宿主及 GitHub 验收报告保留原始命名，由协调方另行说明，不做全局替换。

本次命名/双用途打包回归：**31 个源码测试、10 个打包入口集成均通过**，本地 typecheck 与 Bun build 通过；先补配置红测试再改名。新日志单独保存在 [plugin-github-naming-alpiqvr7](evidence/plugin-github-naming-alpiqvr7/validation.json)，通过 GHC_EVIDENCE_DIR 隔离资源记录。现有历史文件与父会话脚本按本轮快照核对无改写；真实新 marketplace 安装与新 namespace 的宿主验收仍由协调方负责。

在本仓库执行 `bun install --frozen-lockfile`。以新的 `GHC_STATE_DIR` 隔离测试，不要与日常 session 共用恢复文件：

```bash
GHC_STATE_DIR=/private/tmp/your-isolated-state \
GHC_CONSUMER_FILE=/private/tmp/your-private-directory/consumer.json \
bun src/cli.ts stdio
```

恢复文件目录由运行时创建为 0700，文件为 0600。文件包含凭据，不能打印、提交或贴到日志。**不要给两个独立 session 配同一个 GHC_CONSUMER_FILE**：那代表显式接管恢复，不是创建另一个消费者。

MCP 工具输入（准确 JSON Schema 可通过 tools/list 获取）：

```json
{
  "subscribe": {
    "targets": [
      {"kind":"pr","host":"github.com","repo":"owner/repo","number":42,"events":["lifecycle","comments","reviews","review_comments"]},
      {"kind":"run","host":"github.com","repo":"owner/repo","run_id":"123","attempt":"latest","events":["run","job","step"]}
    ],
    "initial":"snapshot",
    "delivery":{"mode":"auto","detail":"steps"}
  },
  "subscriptions":{"limit":20},
  "unsubscribe":{"watch_id":"watch_RETURNED_BY_SERVER"},
  "snapshot":{"subscription_id":"sub_RETURNED_BY_SERVER"},
  "events":{"subscription_id":"sub_RETURNED_BY_SERVER","after_seq":0,"limit":50},
  "ack":{"subscription_id":"sub_RETURNED_BY_SERVER","through_seq":1},
  "delivery":{"channels":"unknown","monitor":"unknown","evidence":"No explicit host evidence"}
}
```

其他 targets：`kind=issue,number`、`kind=workflow,workflow_id,branch?`、`kind=repository,objects=[issue,pr],events=[lifecycle]`。host 默认 github.com，run attempt 默认 latest。ID 字符串必须为正十进制，Issue/PR number 为正整数；path、事件类别和未知字段会校验。自然语言仅由宿主 skill 转成这些结构，不作为 shell 执行。

### 明确宿主投递证据

- 默认 Channels/Monitor 都 unknown；连接成功不改变该状态。
- 宿主确实启用此 channel 后，可设置 GHC_CHANNELS_STATE=enabled + GHC_DELIVERY_EVIDENCE，或调用 delivery 提供同样证据。插件记录声明，不具备自动验证任意宿主配置的通用接口，不能捏造检测成功。
- Channels unavailable、Monitor available 且有明确依据时，返回的 consumer_bridge.stream_argv 给宿主 Monitor 使用；插件不会自行调用/伪造 Monitor。
- stream 默认 5 分钟，最大 30 分钟；宿主更小 cap 仍应遵守。EOF、失败、信号、到期会 detach；订阅保留、不无限自动续接。
- 强杀等来不及执行 finally 的退出由 delivery lease 心跳过期识别，默认约 15 秒后标记 detached；adapter 活着不能替代 Monitor 流本身的心跳。
- 两条主动通道互斥并有 lease/epoch fencing；已经进入宿主队列的旧通知不能撤回，允许至少一次重复。事件 ID 和 ack cursor 不随通道切换重置。
- watch_id 不等于 Monitor task_id。插件不改 AppState，Monitor task 停止不自动 unsubscribe；取消 watch 后只有无剩余 watches 时才应由宿主停止对应共享任务。

### 进程与 profile

daemon.json 记录当前 daemon PID/socket/start time；运行目录为用户私有。profile 键纳入 GH_CONFIG_DIR/认证来源环境的摘要，不把 token 写入文件名或日志。`/user` 数字身份改变则暂停整个 profile，停止投递并拒绝 snapshot/events；subscriptions/unsubscribe 仍可用于诊断/退出。

GH_CONFIG_DIR（及默认 XDG/HOME 配置目录）按绝对路径区分 profile，避免不同 cwd 的相对配置路径混用。私有恢复文件还保存该 consumer 的 socket；CLI stream 可直接使用它，不要求宿主 Monitor 继承 MCP 进程的环境。恢复 stdio adapter 时若当前 profile 与文件 socket 不符，明确拒绝而非跨 profile 接管。

GH_CONFIG_DIR 中相同账号凭据权限变化无法仅靠 user ID 自动发现，需操作者显式重启/重新绑定。认证状态不是会话之间的任意凭据代理。stop/clean 是 OS 用户私有 Unix socket 管理操作，stop 影响同 profile 其他 session，不能在默认 unsubscribe 时调用。

gh host 限于 GHC_ALLOWED_HOSTS（默认 GH_HOST 或 github.com），避免恶意描述指定其他站点导致 gh 发送企业认证；该配置也参与 profile 隔离。adapter 连接前检查 socket 为当前 OS 用户拥有的 0600 socket，不跟随 symlink，以免 /tmp 预占路径冒充 daemon。

## 当前取舍与限制

1. 当前不支持 labels/assignee/actor 等额外过滤参数，schema 不会悄悄忽略它们；明确要求这类条件应澄清/报告不支持。已支持 workflow branch 和 repository issue/pr 选择。
2. comments/reviews/timeline/workflow runs 为完整分页 reconciliation；Repository 更新发现使用 since 回退 120 秒。完整扫描可能昂贵；单端点最多 1000 页、累计响应数据 32MiB，超出明确报错、不推进快照。不是无限规模历史索引。
3. 条件 GET 使用按 host+完整 URL/分页参数区分的内存 ETag 缓存；304 fake 路径已测，真实 gh 304 行为仍待外部验证。缓存不会跨 daemon 重启保留。
4. 默认本地请求预算 3500/hour、串行请求至少间隔 100ms；有 x-ratelimit-limit 时为其保留 30% primary 额度，遵守剩余额度/reset/retry-after。预算是此 daemon 的保守上限，不代表其他程序的用量已被精确控制。
5. run 运行中/最终核对中 15 秒、queued 30 秒。固定 attempt 须确认请求的 job/step 范围完整、所有请求子记录已有终态与结论，并在两次成功采集中状态/结论/子记录集合一致后才停止；latest 在同样确认后降至 5 分钟。采集范围通过快照 meta.action_events 标记，旧快照缺少范围证明会继续采集。workflow 每次分页刷新请求的 job/step，不再复用 completed run 的不完整子记录，代价是请求量增加，仍受全局预算控制。其他目标默认 60 秒。GHC_POLL_MS/GHC_GH_INTERVAL_MS 是可重复测试开关，真实 GitHub 验证不要使用测试中的 150ms/0ms。
6. 周期身份核对最多有约 60 秒检测窗口；显式订阅（包括幂等重试）也会核对身份。身份查询 401/403 时暂停缓存读取/推送，后续成功认证可恢复读取，但主动投递仍需重新 attach；账号 ID 变化则要求新 profile 绑定。auth 失败不会伪造对象删除。相同用户 token 权限收缩不一定导致 user 查询失败，仍需依操作者显式重新绑定。
7. 故障后的旧 Unix socket 不会被自动删除；启动失败会指出日志/socket，操作者核对进程归属后处理。正常退出/测试回收会移除 socket。原生 monitor_mcp 与标准 MCP tasks 均未作为外部注册协议实现。
8. 快照差分不能还原每个瞬时源端变化；timeline 可补偿已可见历史但没有持久增量游标。删除评论、review thread resolved/outdated、PR head 自动关联 CI 不在当前范围。跨 collector 的相同源记录可共享 event_id，但无法证明同一源变更的 timeline/快照不做冒进合并。
9. subscribe 返回规范化 targets、subscription IDs 和 delivery 状态；完整初始快照通过 snapshot 工具读取，避免默认把大批历史评论注入上下文。长评论的推送/Monitor 只含有界摘要，完整内容通过 events 读取。

## 本地验证与证据

已先建立最小测试，初次 `bun test tests/core.test.ts` 因 schema 模块尚不存在失败，再实现规范化/边界校验；后续逐步添加 Store、fake gh、MCP/IPC/stream 回归。不将“初次模块缺失”描述为已证明所有业务路径的红测试。

命令及原始输出：

- `bun test` → [bun-test.txt](evidence/bun-test.txt)
- 本地 devDependencies 中的 `bun run typecheck`（`tsc --noEmit`）→ [typecheck.txt](evidence/typecheck.txt)
- `bun run build` → [build.txt](evidence/build.txt)
- `GHC_TEST_ENTRY=dist/cli.js bun test tests/integration.test.ts` → [bundled-integration.txt](evidence/bundled-integration.txt)
- docs/evidence/integration-*-resources.json：每次集成测试的 daemon/adapter/stream/fake gh PID、socket、临时目录、退出日志及 reclaimed/remaining_pids。凭据和 fixture 私有状态结束后回收，证据不含它们。
- bootstrap-*-resources.json 和 unit-gh-*-resources.json 记录自动启动竞争及独立采集器测试的进程回收；validation.json 记录最终各命令退出码、时间与锁文件内容 hash。
- 初次类型检查发现脚本缺少模块边界，已修复；原失败保留于 [typecheck-initial-failure.txt](evidence/typecheck-initial-failure.txt)，最终通过结果是 typecheck.txt。

本轮独立审查修复后：源码测试 **29 passed / 0 failed**，打包入口集成 **10 passed / 0 failed**，本地 `tsc --noEmit`、冻结安装和 Bun build 均通过。精确退出码、时间与锁文件 hash 见 evidence/validation.json；构建产物在验证后回收。

### 独立审查修复与本地工具链

- 修复前先运行 5 个最小回归，全部按预期失败：completed workflow 扩展 job/step、同 identity 事件合并、固定 attempt 提前停止、拆分 Issue targets 正反序的历史评论误报。红测试原始输出见 [review-regressions-red.txt](evidence/review-regressions-red.txt)。
- 同 identity targets 合并事件后只初始化一个基线，不再让同 key samples 覆盖另一范围。按正反序用例覆盖规范化和真实 MCP 采集。
- 额外覆盖共享 attempt 的窄 run-only 订阅不能提前停止已有 job/step 订阅；该同根失败先复现于 [shared-attempt-red.txt](evidence/shared-attempt-red.txt)，再以实际采集范围证明修复。fixed-attempt fake gh → Store 测试覆盖子记录终态后仍继续一次最终读取。
- 用户批准新增 typescript 与 @types/bun 两项 devDependencies，已用 bun add -d 安装并更新 bun.lock；typecheck 改为标准本地 tsc --noEmit，删除一次性外部工具链脚本，不再需要外部仓库类型路径或全局编译器。
- 保留 Bun/TypeScript 是为了复用现有 MCP SDK、内置 SQLite 和 stdio/daemon 实现；开发声明依赖不会成为新的运行时服务。不为减少类型依赖而改用 Python/uv 重写，也不新增额外运行时依赖。build 继续用 Bun 内置打包。

本地 covered：双 MCP client 真 stdio 子进程、同一 daemon、归属隔离、规则去重、ACK 越界与独立进度、Channels 通知合约、Monitor CLI stream 与到期、lease fencing、PR merge/review/inline、Actions attempt/job/step、仓库新建发现、101 条评论分页、SQLite 重启/恢复、retention gap、初始化失败原子性、账号切换、只读 GET、401/403/404/429、ETag304、超时子进程回收和管理 stop/clean。

以上为本地自动化测试阶段的覆盖边界，不单独证明外部系统行为。协调方随后已补充 [真实 GitHub 验收](github-validation-results.md) 与 [参考 fork 宿主交互验收](host-validation.md)：实际 GitHub Issue/PR/Actions、SDK Channels/CLI stream、真实宿主插件装载、三个 skills、Channels 接收与 Monitor fallback 均有独立证据。

剩余 **not covered**：官方 CLI parity、真实模型语言理解、通用宿主自动能力探测、显式宿主 Monitor TaskStop、Marketplace 安装发布、多机器/GHES，以及真实 GitHub merge/rerun 等未在远端矩阵执行的路径。详见各验收报告，不将模拟测试或宿主 fixture 冒充真实远端/模型证据。
