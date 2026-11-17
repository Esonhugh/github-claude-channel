# github-claude-channel：基于 gh CLI 的多 session 订阅插件

研究日期：2026-11-17。状态：设计基线；本地运行时已实现并进行 fake gh/MCP 自测，当前实现差异、验证状态及证据以 [implementation.md](implementation.md) 为准。本文未来验收要求不代表已经通过真实宿主/真实 GitHub 验收。

## 1. 结论与范围

建议实现独立的 `github-claude-channel` 插件：每个 MCP 连接启动一个 stdio adapter；同一操作系统用户、同一认证 profile 的 adapter 共享本机 watcher daemon。daemon 使用 `gh api` 查询 GitHub，通过 SQLite 保存订阅、快照与已采集事件，按消费者定向投递。

这不是把 GitHub 所有事件当作 agent 指令的桥接器。首版只读，不调用 LLM API、不提供 GitHub 写工具、不声明 `claude/channel/permission`，GitHub review approval 不具有本地工具授权含义。

必须覆盖：

- 一个客户端/session 订阅多个仓库、run、workflow、Issue、PR；多个 session 的订阅、确认和取消互不影响。
- Actions run 的排队、运行、结论，job/step 状态与重跑 attempt。
- Issue / PR 的普通评论；PR review 意见、行内 review comment。
- Issue opened/closed/reopened；PR opened/closed/merged/reopened、draft 转换、head SHA 变化。
- 仓库级发现新 Issue / PR，与指定编号的对象订阅分开。
- 支持 Channels 的客户端接收推送；其他 MCP 客户端通过工具主动读取同一事件集。

可靠性承诺仅限于**已采集并持久化的事件可重放**。纯轮询不能保证捕获源端每次瞬时变化，Channels 写出成功不代表客户端或模型已经处理。

## 2. 证据与事实边界

### 已核对的本地事实

参考实现基线：Esonhugh/claude-code 的 `51d3573d`。下表路径相对于该参考仓库，不属于本独立仓库；仅用于解释现有宿主集成能力，插件设计不依赖读者拥有该源码。以下行号不是运行证据。

| 事实 | 源码位置 |
| --- | --- |
| 通知格式为 `notifications/claude/channel`，content 是字符串、meta 为字符串字典 | `src/services/mcp/channelNotification.ts:30` |
| meta key 被过滤，source 由宿主连接名决定 | `src/services/mcp/channelNotification.ts:96` |
| capability、组织策略、session 选择和来源/allowlist 共同控制通知注册 | `src/services/mcp/channelNotification.ts:169` |
| manifest 支持 inline 或文件形式的 mcpServers | `src/utils/plugins/schemas.ts:584` |
| 本 fork manifest 支持 channels[].server / displayName / userConfig | `src/utils/plugins/schemas.ts:718` |
| 插件首先发现 `.mcp.json` | `src/utils/plugins/mcpPluginIntegration.ts:133` |
| stdio transport 传入 subprocessEnv 和 server env；此处没有显式 conversation ID 合约 | `src/services/mcp/client.ts:1341` |

研究环境 `gh version 2.93.0` 的 `gh api --help` 已确认 REST/GraphQL、`--hostname`、`--method`、`--include`、`--paginate`、`--slurp`。传入 field 默认可能切成 POST，因此所有 REST 读取必须显式 `--method GET`。

`gh run view --help` 提供 attempt/jobs/status/conclusion 等 JSON 字段，并说明日志可能无法可靠关联 step。设计不解析其终端展示，不将日志作为 step 状态的唯一来源。

`gh help environment` 确认环境 token 优先于登录存储；GH_CONFIG_DIR 控制配置范围。研究未读取任何真实 token、私有配置或仓库数据。

### 已核对的官方文档事实

- Channels 使用本地 stdio MCP；notification 无处理确认，未通过 Channels 准入的通知可能被宿主丢弃。[S1]
- Issue 列表支持 state=all、since、sort=updated；其结果包含 PR，需用 pull_request 字段区分。[S2]
- Issue/PR 普通评论和 review comments 是不同 API；单 Issue comments 不支持 sort/direction，但支持 since。review comments 支持 updated/since。[S3][S4]
- PR reviews 列表无 since，review summary body 可修改，不能只用 review ID 判断是否有变化。[S5]
- jobs 可按 run attempt 分页查询，step 包含 number/name/status/conclusion/started_at/completed_at。[S6]
- timeline 可查询 Issue 和 PR 的活动，支持分页，没有已文档化的 since 或持久增量游标。[S7]
- 常见认证用户 REST 主额度为 5000 次/小时；还存在共享并发、points 和 CPU 等 secondary limits。实际以返回头和认证类型为准。[S8]
- 正确授权的条件 GET 返回 304 不消耗 primary quota；仍有请求、进程和 secondary 成本。[S9]

### 尚未验证，不能当作能力承诺

- 本轮抓取的 GraphQL objects 文档未实际展开 reviewThreads/timelineItems 字段，thread resolved/outdated 与嵌套分页留待 schema/fixture 验证。[S10]
- 未验证研究环境 `gh api` 对 304 的退出码、空 body 和 response headers 组合行为。
- 未验证 GHES 版本差异、真实权限矩阵、评论极端分页变动、运行中 job 的服务端刷新延迟。
- 未验证自动随 Claude resume 恢复 consumer；没有把隐含环境变量当作稳定接口。

## 3. 架构与替代方案

数据路径：`client → MCP stdio adapter → Unix socket → watcher daemon → gh api → GitHub`。daemon 将查询结果写入 SQLite 后再向各 adapter 分发；stdout 只承载 MCP，诊断写 stderr。

| 方案 | 收益 | 代价与结论 |
| --- | --- | --- |
| 每个 adapter 独立轮询 | 无常驻共享进程，最简单 | session 数直接放大请求，不能共享快照；适合原型，不满足本任务的共享采集目标 |
| 本机共享 daemon | 重叠订阅共用采集，独立投递，进程重启可恢复 | 要实现启动互斥、版本协商、空闲退出；本任务推荐 |
| 单个远程 HTTP MCP 服务 | 适合跨机器集中化 | 需要网络身份、凭据托管和远程推送兼容；不属于首版 |

共享 daemon 不是 MCP 的硬性要求，也不是多 session 正确性的必要条件；它是本任务减少重复请求的工程选择。首版只实现共享模式，不同时维护两套轮询后端。

建议模块：`adapter.ts`、`daemon.ts`、`github.ts`、`store.ts`，规模增长后再按实际边界拆分，不预先引入消息总线、provider 框架或多层 repository abstraction。

### 打包建议

- `.claude-plugin/plugin.json`：插件元数据；fork 下可选 channels 声明。
- `.mcp.json`：stdio server `github-claude-channel`，命令为 Bun，脚本路径使用插件根路径变量。
- `skills/github-claude-channel/SKILL.md`：解释订阅工具及外部内容信任边界；不负责维持后台轮询。
- `src/` 与测试：插件内部实现。

普通 MCP 配置不自动启用 Channels。自定义频道需遵守宿主 allowlist/开发确认机制；不能声称装上插件就能在所有官方客户端主动推送。[S1] fork 的 channels manifest 扩展也不能直接宣称为官方插件 schema 保证。

## 4. 身份、认证范围与连接恢复

### Consumer 与 connection

- connection_id：adapter 与 daemon 之间的短期连接 ID。
- consumer_id：daemon 分配的持久逻辑消费者 ID；它是标识，不是认证凭据。
- MCP initialize.clientInfo：仅供显示/诊断，不是唯一 session 身份，更不是安全身份。
- 不要求标准 MCP 提供 Claude conversation ID，也不推断同名客户端属于同一用户会话。

默认新 adapter 创建新 consumer；显式恢复由 adapter 启动参数指定本机 recovery handle 文件，文件包含随机恢复凭据，权限限当前 OS 用户。凭据不放入工具返回、通知、URL 或日志。数据库仅存凭据摘要。恢复 handle 由本机操作者配置，不由评论内容或模型随意提供。

一个 consumer 默认仅有一个 active connection；恢复时通过原子更新递增 connection epoch，旧连接被 fencing，避免两个进程同时推进游标。消费者身份不能通过任意工具参数切换，所有工具在连接上下文绑定 consumer。

这只做同一 OS 用户下防误路由/误恢复，不声称能隔离恶意同 UID 进程。跨用户/跨机器访问是另一个威胁模型，首版不开放网络端口。

### gh 认证 profile

daemon 共享键至少为 OS 用户 + 显式 profile。profile 固定 host、GH_CONFIG_DIR 范围、启动时认证环境来源；不把 token 或配置文件内容写入共享键或日志。

- daemon 使用自身固定启动环境执行 gh，不能隐式沿用第一个会话认证后让其他会话混入。
- 不同 GH_CONFIG_DIR/host/认证来源不共享 daemon；使用环境 token 的 adapter 默认进入独立 profile，显式配置后才允许共享。
- 开始采集及周期性核对当前 `/user` 数字 ID；账户变化立即暂停旧订阅和私有缓存投递，通知重新绑定，不自动迁移。
- 仅核对 user ID 无法识别同账号 token 权限收缩/轮换；因此 profile 认证变更要求显式 restart/rebind，列为边界而非宣称自动发现所有变更。
- fine-grained token 至少按需具备 Actions/Issues/Pull requests read；classic token 私有仓库范围按 GitHub 要求配置。安装不自动执行 gh auth refresh 或扩权。
- 404 可能代表不存在，也可能代表不可见；不得自动判定为对象已删除，更不能据此向客户端展示旧私有数据。

## 5. 订阅对象与事件

对象身份统一为 host + repository ID（发现前先用 owner/name 解析）+ kind + object ID。所有对外数字 ID 用十进制字符串；Issue/PR 使用用户熟悉的 number，不混用 GraphQL node ID。

| kind | 参数 | 行为 |
| --- | --- | --- |
| run | run_id, attempt=`latest` 或指定正整数 | 跟踪该 run 的当前 attempt，或固定 attempt |
| workflow | workflow_id, 可选 branch | 发现此 workflow 后续 runs，再跟踪各 run |
| issue | number | 评论及生命周期 |
| pr | number | 普通评论、reviews、行内评论、生命周期 |
| repository | objects=`issue/pr`, 可选过滤 | 发现新建及更新对象；不默认跟踪所有评论 |

事件类别：

- `actions.run.discovered/changed/completed`、`actions.job.changed`、`actions.step.changed`。
- `issue.opened/closed/reopened`、`issue.comment.created/edited`。
- `pr.opened/closed/merged/reopened/ready_for_review/converted_to_draft/head.changed`。
- `pr.comment.created/edited`、`pr.review.submitted/changed`、`pr.review_comment.created/edited`。

PR merged 与 closed 是互斥的终态表达：同一次合并只发 merged，不再重复发 closed。Issue closed 保留原始 state_reason，不用固定枚举强行拒绝未来值。Actor 只有源事件明确给出时才填，不能把对象作者当操作者。

Actions 保留原始 status/conclusion，兼容新增值；不把 cancelled、skipped、timed_out 统一改写成 failure。进度展示 completed/running/queued jobs 和当前 step，不生成伪精确百分比。

同 run 重跑必须包含 run_attempt；job 用 job_id 标识，step 用 attempt + job_id + number 标识，不用可能重复的 step name。`attempt=latest` 的 run 完成后仍需低频核对，以发现未来重跑；固定 attempt 也必须在请求的子记录范围完整、终态及结论齐备，并通过两次一致的最终采集后才能停止。仅 run.status=completed 不足以停止或跳过子记录采集。完成不自动删除用户订阅。

删除评论、review thread resolved 等先不承诺事件支持。缺少列表项不能直接推断删除，必须专门核验并有完整扫描证据；轮询看不到创建后立即删除的评论。

## 6. 工具合约提案

所有 schema 都拒绝未知字段；host/repo/number/ID 在边界验证。下面是设计合约，当前准确 schema 由本插件 tools/list 提供，不应与其他 GitHub MCP server 的同名工具混淆。

### subscribe

```json
{
  "targets": [
    {"host":"github.com","repo":"owner/repo","kind":"run","run_id":"123456789","attempt":"latest","events":["run","job","step"]},
    {"host":"github.com","repo":"owner/repo","kind":"pr","number":42,"events":["lifecycle","comments","reviews","review_comments"]},
    {"host":"github.com","repo":"owner/repo","kind":"issue","number":17,"events":["lifecycle","comments"]},
    {"host":"github.com","repo":"owner/repo","kind":"repository","objects":["issue","pr"],"events":["lifecycle"]}
  ],
  "initial":"snapshot",
  "delivery":{"mode":"auto","detail":"steps"}
}
```

类型约束：targets 为非空判别联合数组；number 为正整数；run_id/workflow_id 为非零十进制字符串；attempt 为 `latest` 或正整数；initial 首版只支持 snapshot；mode 为 auto/pull（auto 按第 13 节 Channels 优先、确认不可用才 fallback Monitor；pull 仅主动拉取）；detail 为 summary/jobs/steps，仅 Actions 生效。仓库过滤按 labels、author、assignee、PR base branch 明确组合语义，不开放任意查询执行。subscribe 不接受用户指定 watch_id。

一个 watch_id 绑定一组 targets，由服务端成功持久化后生成并返回，是订阅句柄，不是 GitHub ID 或恢复凭据。对当前 consumer 规范化完整规则（targets/filter/delivery/initial，目标数组排序与去重）计算规则键，完全一致则幂等返回已有 watch_id，不依赖自然语言原文；不同 consumer 分别创建。规则变化创建新 watch，首版不提供原地更新接口，可成功创建新 watch 后再 unsubscribe 旧句柄。

所有 target 先完成权限/参数校验和基线初始化，任意失败不激活新 watch，返回分 target 错误；全部成功后短事务创建 watch、绑定和基线，提交后返回 watch_id 及每个 target 的 subscription_id/state/baseline_seq/snapshot。连接在提交后丢失时，重试相同规范化规则返回已有 watch，不重复初始化。通知带 watch_id 与内部 subscription_id，ack/replay 始终使用内部 ID。

### 其余工具

| 工具 | 输入概要 | 语义 |
| --- | --- | --- |
| subscriptions | 可选 watch_id 或 subscription_id, cursor, limit | 仅当前 consumer，按 watch_id 分组分页；返回范围摘要、采集状态、最近成功采集时间、待投递数量、health 与 quota；空列表明确无订阅 |
| unsubscribe | watch_id | 解除当前 consumer 的整个 watch；不存在返回 already_absent；事务内设 cancelled，此后不生成新投递；不影响其他 session 和共享采集的其他订阅 |
| snapshot | subscription_id | 返回最近快照、observed_at、stale、last_error，不伪装实时读取 |
| events | subscription_id, after_seq, limit | 读取本订阅事件分页；读不等于 ack；过期范围返回 gap 与最早可用序号 |
| ack | subscription_id, through_seq | 累积确认当前订阅已处理到此处；幂等且单调；禁止超过本连接实际发出/读取的最高序号 |

不支持 Channels 的客户端使用 mode=pull，宿主自行安排 events 调用；标准 MCP 不保证任意客户端自动醒来。不通过 experimental capability 存在与否推断接收方已启用 Channels。

### subscribe 命令 / skill 入口

计划提供 `/github-claude-channel:subscribe`、`/github-claude-channel:unsubscribe`、`/github-claude-channel:list` 三个 skill，语法：

```text
/github-claude-channel:subscribe <描述>
/github-claude-channel:unsubscribe <watch-id>
/github-claude-channel:list
```

`/subscribe`、`/unsubscribe`、`/list` 短名是否可用取决于宿主解析和命名冲突，不保证。subscribe 不设子命令、不要求预先命名句柄；退订仅有独立 unsubscribe 入口，不提供兼容别名。list 复用 MCP subscriptions，不新增重复工具：只列当前 consumer/session，按 watch_id 分组分页，展示目标/事件范围摘要、采集状态、最近成功采集时间、待投递数量。空列表明确显示“无订阅”，不显示其他 session。当前已交付三个 skill 文件；真实宿主 dispatch/装载仍待外部验收。

watch_id 是服务端生成的 opaque 句柄，成功后与规范化订阅范围一同展示给用户。多个目标需要在描述中明确列出。相同 consumer 的相同规范化规则返回已有句柄，不同 session 的订阅独立。unsubscribe 解绑当前 consumer 的该 watch 全部 targets，不接受任意 consumer 参数；不存在返回 already_absent，不影响其他 session 或共享 watcher 的其他订阅。

示例（均为未来语法示例，不是本轮实际订阅）：

```text
/github-claude-channel:subscribe 监听 owner/repo 的 PR #42：关闭、重开、合并、review 和行内意见；同时监听 owner/other 的 issue #17 新评论及关闭、重开
/github-claude-channel:subscribe 监听 owner/repo 的 run 123456789，跟随最新 attempt，通知成功、失败及每个 job/step 状态
/github-claude-channel:subscribe 监听 owner/repo 新建、关闭、重开的 issue 和 PR，不订阅评论
/github-claude-channel:unsubscribe watch_opaque
/github-claude-channel:list
```

skill 在当前请求 session 内将自然语言解析成明确的 host/repo/kind/编号/events/filters，再调用结构化 MCP subscribe/unsubscribe；对象有歧义（如只有“42”）、缺 repo 或“只看重要意见”无法确定过滤时先澄清，不创建订阅。成功后展示服务端返回的 watch_id 与规范化范围，不能把原始描述拼成 shell、gh 参数或执行指令。

订阅归属必须由当前连接决定；首版 skill 不使用 context:fork，也不委派其他 agent 建立订阅。fork 拥有不同连接时不能冒充当前 session。自然语言解析使用宿主模型已有能力，插件不额外调用模型 API。

## 7. 标准事件与投递

事件正文示例：

```json
{
  "schema_version":1,
  "event_id":"evt_opaque",
  "type":"pr.review.submitted",
  "host":"github.com",
  "repository":{"id":"123","name":"owner/repo"},
  "subject":{"kind":"pr","number":42},
  "source_id":"review:987",
  "occurred_at":"2026-11-17T01:00:00Z",
  "observed_at":"2026-11-17T01:00:12Z",
  "evidence":"source_record",
  "actor":{"id":"456","login":"alice"},
  "data":{"review_id":"987","state":"CHANGES_REQUESTED","body":"Please add cancellation coverage."}
}
```

occurred_at/actor 无来源则为 null/缺失；evidence 区分 source_record 与 snapshot_diff，不能凭快照伪造真实事件时间或操作者。链接取 GitHub 返回的 html_url，不拼接未知 host URL。行内评论保留 path/line/side/diff_hunk/in_reply_to_id/commit_id；文件路径仅是数据，不拿来直接执行文件操作。

通知使用 `notifications/claude/channel`，meta 只放字符串形式的 event_id、subscription_id、delivery_seq、repo、type；结构化事件通过 events 工具读取。content 为有界摘要并标注外部数据，完整评论保存在本机并按需读取。

每个 subscription 独立有 delivery_seq/acked_seq。一个源事件匹配当前 consumer 多个订阅时，一条通知携带多个 `{subscription_id,seq}` delivery reference（JSON 放 content 或由 events 查询，不将对象塞进 meta），ack 仍逐订阅进行。不能只给一个 subscription_id 却声称重叠订阅全部已确认。

投递保证：

1. 事务提交 event 和 delivery 后才向 adapter 写出。
2. await notification 只表示写 transport，不推进 ack。
3. 断线后未 ack 的记录允许重投，保持 event_id 稳定；不承诺 exactly-once。
4. ack 表示客户端/模型主动声明处理完成，不提供宿主处理成功的强证明。
5. 超出保留窗口显式返回 gap；客户端重新 snapshot，不能静默把 cursor 推过缺口。
6. 不同对象没有可信源端全局顺序，delivery_seq 只表示本地入库顺序。

## 8. gh 查询计划与差异识别

```text
GET /repos/{owner}/{repo}/actions/runs/{run_id}
GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs
GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs
GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=asc&since=...
GET /repos/{owner}/{repo}/issues/{number}
GET /repos/{owner}/{repo}/issues/{number}/comments?since=...
GET /repos/{owner}/{repo}/issues/{number}/timeline
GET /repos/{owner}/{repo}/pulls/{number}
GET /repos/{owner}/{repo}/pulls/{number}/reviews
GET /repos/{owner}/{repo}/pulls/{number}/comments?since=...&sort=updated
```

jobs、Issue、comments、reviews、timeline 列表均要处理分页。workflow discovery 端点列为实现前补充字段/过滤/分页验证项，不能把列表最后一个 run 当完整历史游标。

示例 argv 等价命令：

```bash
gh api --hostname github.com --method GET --paginate --slurp \
  repos/OWNER/REPO/actions/runs/RUN_ID/attempts/ATTEMPT/jobs \
  -f per_page=100
```

实现使用 Bun spawn 的 argv 数组，不执行拼接 shell；所有 URL path segment 从经过验证的类型值构造。GH_PROMPT_DISABLED=1、禁用 pager；为每次 gh 设置超时与输出大小上限，超限显式报错/缩小页读取，不吞掉或截断 JSON 后继续。

### 水位与分页

- 以扫描开始时间确定固定上界，使用重叠 since（初始建议回退 120 秒）处理边界同秒、延迟可见与并发更新；该值不是完整性保证。
- 只有所有必要页面完成并持久化后才推进该数据源水位；中途失败不推进。
- 去重按源 ID + 已核对业务内容版本，而不是仅 updated_at。JSON hash 规范化业务字段，不包含路径、采集时间和分页位置。
- 评论 created/edited 以已知 ID、created_at、updated_at 和 body 变化判断；首次初始化的历史项进 baseline，不伪造成新事件。
- reviews 无 since，按对象分页 reconciliation，比较 review body/state；不要只扫描最后一页。
- Issue 列表的 pull_request 项还需 PR 详情补充 merged/draft/head。不要只靠父对象 updated_at 发现所有子资源变化。
- timeline 用稳定源 ID 去重并分页补查 close/reopen/merge 等历史。没有 since/持久游标，不能把事件 ID 当可排序增量 offset；小对象可全扫，大对象需要限额分批且明确 lag。
- 快照差异与 timeline 可能表达同一变更：源记录优先；无法证明同一变更时明确 evidence，不用接近的时间戳强行当同一事件。详情状态持续作为 reconciliation 依据。

### 订阅初始化的并发基线

为目标建立 initializing 订阅，不立即推送历史内容。若已有共享快照，在一个短 SQLite 事务中读取 snapshot 与当前 event offset 并建立 baseline。若目标尚未采集，先在 DB 事务外做网络抓取，再由该目标串行 collector 在短事务中提交 snapshot、events 和新订阅基线。

目标 collector 提交串行化防止旧快照覆盖新快照；不能持有数据库写事务等待 gh。初始化期间后续轮次产生的事件在基线后进入该订阅。多页 API 没有原子快照，仍需重叠扫描与 reconciliation 修复；不能声称消除了源端所有初始化 race。

## 9. 最小持久化模型

每个 profile 一份 DB，SQLite WAL、短事务。以下为设计逻辑表；当前具体列、migration 和状态实现见 src/store.ts 与 implementation.md，不应把逻辑表当作逐列相同的 SQL schema：

| 表 | 最小字段/约束 |
| --- | --- |
| consumers | id, recovery_hash, connection_epoch, state, last_seen_at, expires_at |
| watches | watch_id 主键, consumer_id, rule_key, normalized_rule_json, description, state；当前 consumer 的 active rule_key 唯一；服务端生成句柄，与 GitHub ID/恢复凭据分离 |
| subscriptions | id, consumer_id, watch_id, target_key, filter_json, delivery_json, state, baseline_offset, next_seq, acked_seq, sent_seq；watch 内规范化 target 唯一约束 |
| targets | key, identity_json, snapshot_json, source_cursors_json, next_poll_at, last_success_at, last_error, generation |
| events | offset 整数主键, event_id 唯一, target_key, source_key/version, payload_json, observed_at |
| deliveries | subscription_id + seq 联合主键, event_id；subscription_id + event_id 唯一约束 |

source_cursors_json 保存分端点水位/分页 continuation，而不是维护一个覆盖所有数据源的 since。sent_seq 用于校验本连接实际提供过的事件；重连后未 ack 记录重新提供。事件引用仍存在时不能被 clean 提前清掉；超过保留策略时先记录/暴露 gap 再删除。

生命周期：consumer `active → disconnected → expired`，凭有效恢复凭据可从 disconnected 回到 active；subscription `initializing → active ↔ degraded/paused → cancelled`。degraded 表示临时采集故障，paused 表示认证变化等需要重新绑定；单个 run 完成不是取消订阅。

## 10. 速率预算与调度

建议初值而非服务 SLA：运行中 run 每 15 秒查 run + jobs；queued 每 30 秒；PR 详情/评论/reviews/review-comments 每 60 秒；Issue 每 60 秒；timeline 和终态 latest-run 每 5 分钟。消费者提出更快频率时先受 profile 全局预算约束，返回实际间隔。

忽略分页和 304 的保守例子：

- 一个 active run：2 × 3600/15 = 480 requests/hour。
- 5 个 active runs：2400/hour。
- 10 个 PR，4 个端点/分钟：2400/hour。
- 小计 4800/hour；再加 10 个 PR timeline 每 5 分钟约 120/hour、认证检查和仓库发现，已接近或超过常见 5000/hour。

因此前一轮简单罗列 10–15 秒轮询间隔并不足以支持大量目标。首版必须有按 profile 的预算调度和 reserve，例如只规划当前可用额度的 70% 用于常规采集，优先 active run，延后低优先级 reconciliation，subscriptions 返回实际 next_poll_at/lag。不要固定宣称 5000 是所有认证方式的额度。

共享采集使相同 target 的 10 个 session 不增加采集次数；不同 targets 仍线性增加。每页都计请求，不能把一次 --paginate 进程视为一次 API 请求。初始采用串行 gh 请求队列；无需一开始并发到 API 上限。

条件请求按每个 URL/参数/页独立保存验证器，匹配对应快照；不同页不能复用一个 ETag。304 不推进丢失 body 的新快照；认证正确时可节省 primary quota，但不消除 secondary/CPU/gh 子进程成本。

401、403、404、429 分别结合响应内容和 quota headers 分类；403 不一律当限流。遵守 Retry-After/reset；secondary 无明确时间按官方建议至少一分钟并指数退避，期间展示 degraded，禁止忙重试。

## 11. 运维、安全、回收

- socket/DB/recovery handle 存当前用户私有运行目录，不放插件安装缓存或仓库；目录 0700、文件 0600。
- daemon 单实例用原子 lock；已有 socket 无响应不直接删除，先核对本 profile lock/进程归属，失败清晰报错。版本不兼容时不强杀正在服务其他 session 的 daemon。
- adapter EOF 关闭连接并回收本次 gh 子进程；daemon 监听 SIGTERM 做有界 drain，未 ack 不丢弃。
- disconnected consumer 停止主动投递；初始恢复窗口建议 24 小时，事件保留建议 7 天。最后活跃 consumer 离开后停止高频采集，默认不做无限离线监控；恢复期间未采集的源端变化依靠 reconciliation，仍可能缺失。
- 无 active consumer 后 daemon 空闲 5 分钟退出。持久订阅保留不等于 daemon 永久运行；未来离线持续监控应作为显式部署模式。
- 提供本机 status/stop/clean；stop 作用域为当前 profile，clean 只清到期记录，不删除仍需重放的数据。无需新增系统 launch agent 或修改全局设置。
- subscriptions 展示 last_successful_poll、next_poll_at、snapshot_age、lag、last_error、rate_limit_remaining/reset、pending_deliveries、acked_seq、gap。
- 不记录 token、Authorization、评论全文和日志全文；诊断只输出 host、非敏感 profile 名、对象 ID、耗时、HTTP 状态和错误分类。
- 公开 PR 内容是实际 prompt-injection 入口。默认只作为外部数据，不作为操作授权；用户允许的 GitHub 数字 actor ID 可作为后续协作过滤，但 allowlist 也不等于绕过宿主权限。
- 本地 socket 不是 GitHub 授权代理，客户端不能提交任意 gh 命令或路径；daemon 仅执行实现中定义的只读查询。

## 12. 分期实施与验收门槛

### P0：先证明边界

- 用模拟 gh 可执行文件覆盖分页、304、401/403/404/429、超时、大输出、同秒编辑与非原子列表。
- 核实 source schema、gh 304 行为、review/timeline 的实际载荷，固定最小 fixtures；不得把本轮文档核对当作 binary 验收。
- 认证 profile、consumer recovery/fencing、初始化基线和 ack 越界先写失败测试。

### P1：只读可用版本

- 共享 daemon/adapter、SQLite、subscribe/subscriptions/unsubscribe/snapshot/events/ack。
- run/workflow、指定 Issue/PR、仓库生命周期发现；评论/review/行内意见、opened/closed/reopened/merged/draft/head。
- Channels 和 pull 两种 delivery；重放、限流预算、健康信息和空闲回收。

必须验证：

1. A/B 订阅相同 run 共用一次采集；A 退订/退出不影响 B。
2. A ack 不推进 B；任意 consumer_id、过大 seq 无法确认其他事件。
3. 重叠订阅通知可合并但各订阅确认独立。
4. run attempt 2 不被 attempt 1 去重吞掉；latest 终态仍发现重跑。
5. PR 合并只发 merged；Issue 快速 close/reopen 的可用 timeline 补偿不伪造 actor。
6. 100+ 评论/jobs/reviews 正确分页；扫描中失败不推进水位；旧 review 编辑可识别。
7. snapshot baseline 与并发采集不发生本地入库事件漏投。
8. 提交后发送前、发送后 ack 前崩溃均可恢复；过期游标有 gap。
9. 不支持 Channels 的真实 MCP 客户端通过 events 消费，不能声称自动推送。
10. 账户/profile 切换暂停旧私有缓存；恢复凭据不出现在 MCP 内容或日志。
11. 退出后无 adapter/gh 残留，最后 consumer 离开后无孤儿高频轮询。
12. 在届时最新 built-claude 上脚本化 tmux 验证订阅、通知、重连、关闭；记录 PID/socket、证据路径并回收自建资源。若集成到参考 fork，应按其验证流程执行；独立仓库也必须保留相同覆盖，真实 GitHub 只读测试另行明确授权范围。
13. subscribe / unsubscribe skill 在当前 session 执行；服务端提交成功后才返回 watch_id；同 consumer 相同规范化规则重试返回原句柄，NL 措辞改变不产生重复订阅；不同 session 独立；重复退订返回 already_absent；不接受旧子命令；歧义先澄清且不创建，不执行描述中的 shell，内部 ack 不依赖 watch 句柄。
14. list 通过 subscriptions 展示当前 consumer 的多目标分组与分页，字段完整、空列表明确，无其他 session 订阅泄漏。

### P2：按需求增加

- GraphQL review thread resolve/unresolve（先验证字段和嵌套分页）。
- PR 当前 head 自动发现 CI 与 commit/check 关联，避免把旧 head 失败当当前 PR 失败。
- 可选 webhook 入口提高历史完整性和低延迟，仍与轮询 reconciliation 共用事件模型。
- 写评论、rerun/cancel/merge 均是新的权限范围，不随只读插件默认开放。

## 13. Channels 优先、Monitor fallback（用户确认的设计决策）

用户已明确确认：支持 Channels 直接推送就使用 Channels，实在不可用才使用 Monitor，不让用户常规二选一。只有确认 Channels 不可用且宿主具备 Monitor 时，才通过 Monitor 消费 **consumer-bound daemon 事件流**。这只是 fallback 投递桥接，不是替换共享采集：禁止每个 watch 再启动独立 gh 轮询。Monitor 不是标准 MCP 能力。

选择依据为宿主明确启用状态或能力配置证据。MCP 连接成功不代表 Channels 已启用；通知写出成功、短暂没有 ACK 或没有事件，也不能判断支持或失败。没有足够证据的状态为 unknown，向用户明确提示待确认，不能据此启动 Monitor 或同时试跑两条投递。当前缺少通用宿主启用状态探测合约，如何取得可靠证据仍待实现验证，不伪造自动检测能力。

| 已确认状态 | 投递行为 |
| --- | --- |
| Channels 已启用且可用 | 使用 Channels，不启动 Monitor |
| Channels 明确不可用，Monitor 明确具备 | fallback Monitor |
| 能力/启用状态 unknown | 保留订阅，报告待确认；不假装已主动监听 |
| 两者皆不可用 | 报告 delivery unavailable，保留 events 拉取 |

subscribe 返回和 list 必须区分“数据层订阅已持久化”与“主动投递已连接”；后者不可用不回滚有效订阅，也不能静默宣称监听成功。

### 已核对的宿主边界

以下源码路径均属于参考仓库 Esonhugh/claude-code，不属于本插件：

- `src/tools/MonitorTool/prompt.ts:7`：默认 5 分钟；虽然常量 MAX_MONITOR_TIMEOUT_MS 为 1 小时，有效 cap 是交互 30 分钟、非交互 10 分钟，不能将常量当实际可用时长。
- `src/tools/MonitorTool/prompt.ts:35`：Monitor 运行 shell，每条 stdout 行作为事件；脚本退出结束监听。
- `src/tools/MonitorTool/prompt.ts:40` 的提示合约说明输出过量会停止；`src/tools/MonitorTool/prompt.ts:65` 说明到期结束并给出通知，需要重新建立监听。这是源码提示合约核对，不是本轮运行实证。
- `src/tasks/MonitorMcpTask/MonitorMcpTask.ts:32`：MonitorMcpTask.kill / killMonitorMcp 只更新 AppState 状态；`src/tasks/MonitorMcpTask/MonitorMcpTask.ts:47` 的 agent cleanup 是空实现，没有证明能终止插件 daemon 或退订。
- 本轮对全 src 检索 monitor_mcp 只定位到任务类型、状态处理、UI 和相关消费位置，未找到外部 MCP 创建/注册该任务的协议。不能据此把 monitor_mcp 当成插件已可调用的公开接口；标准 MCP tasks 也不等同这个宿主内部类型。

### 建议的数据与控制语义

桥接脚本只连接既有 daemon，用当前 consumer 的有效本机绑定消费事件、逐行输出有界摘要；恢复凭据不出现在 shell 命令行或输出中。过滤、分页/重放和采集仍由已有数据层负责。不能从 stdout 写出推断 ack，仍需客户端明确确认。

同一个 consumer/watch 的主动推送通道必须互斥，不能 Channels 与 Monitor 同时发通知。切换复用同一 consumer/watch、持久化 cursor 和稳定 event_id，不能创建另一组订阅或重置确认位置；daemon 原子递增 delivery epoch 并绑定唯一 active delivery。旧 adapter/桥接在输出前校验 epoch，失效通道不再发送，以 single active delivery fencing 防止旧通道迟到造成额外双投。已进入宿主队列的通知无法凭空撤回，未确认事件也可能重放，因此至少一次交付仍可能重复，不承诺 exactly-once。切换竞争和异常恢复属于待验证实现，不是当前已有能力。

watch_id 是数据层订阅句柄，task_id 是宿主任务标识，二者分离。Monitor 到期、脚本退出、过量停止或用户手动停，只使桥接变为 **delivery detached**，watch 数据层仍为 active，不自动等价 unsubscribe。到期必须显式提示需要续接，不无限自动续接，不凭空保证宿主能续接。active 也不保证无限离线高频采集，仍受第 11 节 consumer 离线/空闲策略约束。list 应分别呈现订阅状态和投递连接状态，防止把断流显示成正常推送。

显式 unsubscribe 需要先持久化解绑，再停止受影响的桥接绑定；一个 Monitor 若服务多个 watch，不能因取消其中一个而破坏其余订阅。若产品希望“任务列表停止 = 退订”，需单独增加宿主到 daemon 的认证取消回调及失败恢复，不能声称已有 kill 代码实现了联动。外部插件不能直接修改宿主 AppState；原生任务列表联动属于待验证的宿主增强。

| 选择 | 收益 | 代价 |
| --- | --- | --- |
| Channels（默认） | 使用现有通知合约，adapter 直接路由 | 受宿主准入和 Channels 支持限制 |
| Monitor（仅 fallback） | Channels 确认不可用时利用已有宿主后台事件工具桥接 daemon 流 | 有限时长、过量停、需显式续接，取消不等于退订；不能作为通用 MCP 推送方案 |
| 原生 monitor_mcp 联动 | 可能统一任务列表状态与取消体验 | 未发现外部注册协议，需要宿主增强，当前不可承诺 |

待验证：真实宿主是否提供 Monitor；consumer 绑定与凭据传递；EOF/到期/TaskStop/过量停止后的连接回收和 list 状态；重新建立监听的事件重放/ack；Channels 与 Monitor 切换无双投；多个 watch 共用桥接的局部退订；宿主取消回调断线重试；任务结束后无孤儿进程。后续实施已实现并 fake 自测 CLI 事件流、lease fencing、到期与强杀后的 detached；并未启动真实宿主 Monitor，也未建立或修改宿主原生任务。上述宿主级项目仍 not covered，详见 implementation.md。

## 14. 交付状态与待定事项

独立仓库现已有 Bun/TypeScript 运行时、SQLite、stdio adapter/daemon、插件配置与三个 skills。运行时直接依赖为用户批准的 MCP SDK 和 Zod；开发依赖为随后批准的 typescript 和 @types/bun，使用本地 tsc --noEmit，锁文件为 bun.lock。实施与测试详情见 [implementation.md](implementation.md)；真实 GitHub/宿主验收及 Marketplace 链接登记由协调方处理。未 commit/push 或修改远端状态。

默认建议已给出，实施前仍需收敛：认证 profile 的操作者配置形式、自动随宿主 resume 的可靠身份桥接、离线恢复窗口/保留策略是否合适、超过 API 预算时可接受的实际延迟。它们不能由 MCP clientInfo 或任意 session_id 猜测替代。

研究阶段未运行运行时验证；后续实施已运行 bun 测试、typecheck、build 及 fake gh 双 MCP/CLI stream 集成。文档中的真实 GitHub/宿主/tmux 验收仍是未来门槛，不是 passed 结论。

## 来源

以下官方文档于 2026-11-17 查询；GitHub/Claude 文档会更新，实施时应重核 API 参数和宿主版本。

- [S1 Channels reference](https://code.claude.com/docs/en/channels-reference)
- [S2 Issues API](https://docs.github.com/en/rest/issues/issues)
- [S3 Issue comments API](https://docs.github.com/en/rest/issues/comments)
- [S4 PR review comments API](https://docs.github.com/en/rest/pulls/comments)
- [S5 PR reviews API](https://docs.github.com/en/rest/pulls/reviews)
- [S6 Workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs)
- [S7 Issue timeline API](https://docs.github.com/en/rest/issues/timeline)
- [S8 REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [S9 REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [S10 GraphQL objects](https://docs.github.com/en/graphql/reference/objects#pullrequest)（本轮正文提取未展开目标字段，未验证）
- 本地命令：`gh --version`、`gh api --help`、`gh run view --help`、`gh help environment`。
