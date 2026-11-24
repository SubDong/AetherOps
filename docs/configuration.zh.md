# 配置参考

[English](./configuration.md) · **简体中文**

AetherOps 只有一份配置文件、一套环境变量命名空间，以及数据目录里少数几个你在运维前必须知道的文件。

- [配置放在哪里](#配置放在哪里)
- [优先级](#优先级)
- [`config.json` 各段说明](#configjson-各段说明)
- [环境变量](#环境变量)
- [存储布局](#存储布局)
- [表结构与迁移](#表结构与迁移)
- [什么数据存在哪儿](#什么数据存在哪儿)
- [备份与搬迁](#备份与搬迁)

## 配置放在哪里

| 场景 | 事实来源 |
|------|----------|
| 默认 | `~/.aetherops/config.json` —— 首次运行自动创建，权限 `0600` |
| 显式指定文件 | `AETHEROPS_CONFIG=/path/to/config.json`（绝对路径，或相对于工作目录） |
| 自定义数据目录 | `AETHEROPS_DATA_DIR=/data/aetherops`（`config.json` 的默认位置跟着它走） |

运维上要紧的几条：

- 数据目录的位置**只**由 `AETHEROPS_DATA_DIR` 或默认的 `~/.aetherops` 决定。`config.json` 不可能给
  自己所在目录换地方 —— 那是循环依赖。
- 如果 `AETHEROPS_CONFIG` 指向一个不存在的文件，启动**直接失败**，而不是生成模板。显式给路径的含义是
  「我认为这个文件存在」，静默造一个空文件会制造最难查的那类 bug：「配置读到了，但每个值都是默认值」。
- 不是合法 JSON 的文件会中止启动。无法识别的配置段和键会被报告并丢弃，所以打错字不会「半能用」。
- `auth.disabled` / `auth.accessToken` 来自旧的单令牌方案，已经移除：读到了会被告警并丢弃，标记为
  废弃。认证现在是账号体系的职责。

## 优先级

```
内置默认值   <   配置文件   <   环境变量
```

所以容器镜像可以只靠环境变量指向另一个数据库，而写进文件的密码能扛过重启。取值会做类型转换：数字接受
`"3306"`，布尔接受 `"true"` / `"1"`；类型对不上的值会被忽略并给出警告。

## `config.json` 各段说明

### `server`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `port` | `9802` | HTTP/WS 监听端口。CLI 的 `--port` 与环境变量 `PORT` 优先于它 |
| `host` | `127.0.0.1` | 绑定地址。只有在认证之后、且网络归你控制时才用 `0.0.0.0`。环境变量：`HOST`（优先）或 `AETHEROPS_HOST` |

### `database`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `host` | *空* | MySQL 主机。留空会在启动时报配置错误 |
| `port` | `3306` | |
| `user` / `password` | *空* | 最小权限账号；除非你手工执行 SQL，否则需要 DDL 权限。**密码必须非空** —— 空值按「未配置」处理并中止启动，因此免密的本地 `root` 不能用 |
| `database` | `aetherops` | 库名 |
| `connectionLimit` | `5` | 连接池大小。刻意保持很小：实测共享实例 `max_connections=50`，每个宿主应用吃 10 个扛不住 |
| `connectTimeoutMs` | `10000` | |
| `charset` | `utf8mb4` | |
| `timezone` | `+00:00` | 驱动侧的解释方式。时间戳由应用以 JS `Date`（UTC）写入；表结构里不用 `NOW()`/`CURRENT_TIMESTAMP`，因为参考实例的 `system_time_zone=CST` 会把所有时间整体偏 8 小时 |
| `ssl` | `false` | 启用 TLS |
| `sslRejectUnauthorized` | `false` | 严格证书校验。Ubuntu 自带的 MySQL 用的是无 CA 的自签证书，严格模式默认连不上；关掉后连接仍然是加密的，但不抗中间人 |
| `sslCaPath` | *空* | 提供用于校验的 CA |

会让启动失败的校验规则：`sslCaPath` 有值但 `ssl=false`（CA 会被忽略）；CA 路径不存在；`ssl` +
`sslRejectUnauthorized` 但没有 CA（对着自签服务器必然握手失败）；端口或 `connectionLimit` 超出合法区间。

模板文件里还带一个 `_comment` 键（中文），说明这个文件是干什么用的。加载器忽略它，同样也忽略其他无法识别的
键 —— 但会给出警告，绝不静默。

### `redis`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `url` | *空* | 完整连接串 `redis://:pass@host:6379/0`；一旦设置，下面这些字段全部忽略 |
| `host` | *空* | 必填（否则配置错误） |
| `port` | `6379` | |
| `username` | *空* | Redis 6 的 ACL 用户；只用密码认证就留空 |
| `password` | *空* | 空表示「没有密码」；这种情况下启动会打一条警告，以防服务端其实要求密码 |
| `db` | `0` | 逻辑库 0–15 |
| `keyPrefix` | `aetherops:` | 实例共用时的命名空间；不能为空 |
| `connectTimeoutMs` | `5000` | |

### `auth`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `launchToken` | *空* | 健康检查令牌，由 VSCode/Electron 宿主注入，用来让 `/health` 无法被一个恰好占住端口的无关进程糊弄过去。它不是用户身份 |
| `maxUploadMb` | `100` | 单次上传上限；同时也用来决定 WebSocket 的 `maxPayload` |
| `tokenTtlSeconds` | `7200` | 登录令牌时长（秒）。滑动续期，续期阈值取它的四分之一（上限 1000 秒、下限 30 秒）。小于 60 会被启动校验拒掉 |
| `watchTokenTtlSeconds` | `2592000` | 大屏只读令牌的固定寿命（默认 30 天），**不续期**；设为 `0` 表示禁止签发 |

两个 TTL 只决定「令牌还能用多久」，与权限无关。一个提醒：把 `tokenTtlSeconds` 调到一天以上不会让大屏更省心 ——
大屏应该用只读监控令牌（见[账号、角色与权限](./accounts-and-permissions.zh.md#只读监控令牌)），
而不是把一个登录会话拖成一周。

### `debug`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `sshDebug` | `false` | 把 ssh2 协议层的 debug 输出转发到前端的终端里 |

### `metrics`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `offlineSampling` | `false` | 对**没有**打开终端的机器，也按它保存的连接配置主动拨号采样 |

这个开关改了什么：每分钟一次的采集器原本只遍历活着的会话，从不自己发起连接，所以一台没人连着的机器
在那段时间里没有历史。设 `offlineSampling: true` 后，无人连接的机器会用一个按连接配置建起来的一次性
SSH 通道去采 —— 每台每分钟一次握手，最多 2 台并行，单轮总预算 45 秒，出错后指数退避（1→2→4→8→15 分钟；
认证失败时 30 分钟起）。已经有终端的机器仍然走那条终端，所以这个开关只会为「本来会被跳过」的机器增加登录。

打开之前请先确认副作用：这是一次真实的 SSH 登录，目标机的 `sshd` 会在认证日志里看到它。
要排除某一台机器，把那个连接的 `sampling` 设成 `skip`（见[表结构与迁移](#表结构与迁移)）；
它不影响手动打开终端，也不影响状态面板。

采集器仍然跟着连接的 `host` 走，所以对跳板机连接（带 `startupScript` 继续往里跳的那种），记下来的历史描述的是
AetherOps 实际连上的那台机器 —— 也就是跳板机本身，和状态面板完全一致。跳转这一步不会被重现。

开启之前会遇到的四个问题 —— 为什么默认关、跳板机连接采哪台、采不到的主机为什么不会每分钟重试、
怎么把单个连接排除出去 —— 在 [offline-sampling-faq.zh.md](./offline-sampling-faq.zh.md) 里有完整回答。

### `alerts`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `webhookUrl` | *空* | 告警通知的接收地址。留空表示告警只入库并在界面上展示，不往外推 |
| `webhookSecret` | *空* | `X-AetherOps-Signature` 的 HMAC-SHA256 密钥；留空表示请求不签名（启动时打一条警告） |
| `webhookTimeoutMs` | `5000` | 单次投递的超时时间（毫秒） |

只有**新建**告警和**级别升级**才会往外推。同一个未关闭指纹的重复命中只累加 `occurrences`，不会再叫人一次。
投递按指纹做 5 分钟去抖，失败后按 30 秒 / 2 分钟 / 10 分钟重试（重试 3 次，共 4 次尝试），并且永远不阻塞
日志监控 —— 接收端不可达只会在 `server.log` 里留一条警告。

签名头：`X-AetherOps-Signature: sha256=<hmac-sha256(secret, "<x-aetherops-timestamp>.<原始 body>")>`。
时间戳参与签名，所以抓到的请求不能事后重放。

规则级静默（告警页里的 **静默** 菜单，存在 `alert_mutes`）只压制投递。静默期间的命中照样计数，
窗口过去后能看到那段时间到底发生了什么。

认领、指派与归并都挂在告警旁边，**这一段没有新增任何键** —— 没有可配置的东西：

- **认领**一步完成确认 + 把处理人设成自己；**指派**只改处理人，第一个确认人留给它 —— 这两件事本来就
  不是一回事。可指派成员就是本账号下 `active` 的账号；指派给停用账号会被拒绝。
- **值班**（`alert_oncall`）是「账号 + 一天中的分钟窗口」，`start > end` 表示跨零点，两端都是左闭右开
  （08:00 结束的那一班与 08:00 开始的那一班在接口处交接）。它只改一件事：告警触发时的 webhook 正文里多
  一个 `onCall`（`userId`、`username`、`displayName`、`mention`），写明此刻谁在岗。投递、去抖与重试全
  部不变，也不会另开通知渠道 —— 要不要打电话、发邮件、推 IM，由接收端自己决定。
- **事件**（`incidents`）按主机归并告警：同一连接 30 分钟内凑够 3 条未解决的告警就算一件事，之后同一台
  主机的命中继续并进去，其它行可以手动关联，最后一条关联告警解决时事件自己关闭。这是一条启发式规则，
  不是根因判断 —— 30 分钟窗口与 3 条阈值是 `server/db/repositories/incident.repo.ts` 里的常量，
  不对外开放配置。

`loadConfig` 在进程内缓存，也没有任何东西盯着文件：**改完这一段或 `AETHEROPS_ALERTS_*` 变量必须重启服务**。
本页其它段落同理。

## 环境变量

| 变量 | 映射到 | 说明 |
|------|--------|------|
| `PORT` | `server.port` | 服务端这一段只读 `PORT` |
| `HOST` / `AETHEROPS_HOST` | `server.host` | `HOST` 优先 |
| `AETHEROPS_DATA_DIR` | 数据目录 | 设置后会禁用旧的 `~/.aicmd` 自动搬迁 |
| `AETHEROPS_CONFIG` | 配置文件路径 | 文件不存在即为致命错误 |
| `AETHEROPS_DB_HOST` / `AETHEROPS_DB_PORT` / `AETHEROPS_DB_USER` / `AETHEROPS_DB_PASSWORD` / `AETHEROPS_DB_NAME` | `database.*` | 避免把密钥写到磁盘上 |
| `AETHEROPS_DB_POOL_SIZE` / `AETHEROPS_DB_SSL` / `AETHEROPS_DB_TZ` | `database.connectionLimit` / `.ssl` / `.timezone` | |
| `AETHEROPS_DB_SSL_CA` | `database.sslCaPath` | |
| `AETHEROPS_DB_SSL_INSECURE` | `database.sslRejectUnauthorized`（取反） | 名字里刻意带 INSECURE，复制粘贴时意思不会丢 |
| `AETHEROPS_REDIS_URL` / `_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB` / `_PREFIX` / `_CONNECT_TIMEOUT_MS` | `redis.*` | |
| `AETHEROPS_MAX_UPLOAD_MB` | `auth.maxUploadMb` | |
| `AETHEROPS_AUTH_TOKEN_TTL_SECONDS` | `auth.tokenTtlSeconds` | 登录令牌时长；低于 60 被拒 |
| `AETHEROPS_AUTH_WATCH_TOKEN_TTL_SECONDS` | `auth.watchTokenTtlSeconds` | 大屏只读令牌时长；`0` = 禁止签发 |
| `AETHEROPS_LAUNCH_TOKEN` | `auth.launchToken` | 由桌面/VSCode 宿主设置 |
| `AETHEROPS_SSH_DEBUG` | `debug.sshDebug` | `1` 或 `true` |
| `AETHEROPS_METRICS_OFFLINE_SAMPLING` | `metrics.offlineSampling` | `1` 或 `true`；对没有打开终端的机器也采样 |
| `AETHEROPS_ALERTS_WEBHOOK_URL` / `_WEBHOOK_SECRET` / `_WEBHOOK_TIMEOUT_MS` | `alerts.*` | 接收地址、HMAC 密钥与单次投递超时 |
| `AETHEROPS_NODE` | — | 用来拉起后端的 Node 可执行文件（VSCode 宿主） |
| `AETHEROPS_BUNDLED` | — | 构建期由 `scripts/prepare-vscode-runtime.mjs` 写入，不要手工设置 |
| `AETHEROPS_VSCODE_PRUNE_PREBUILDS` | — | 设为 `1` 时把 node-pty 的 prebuilds 裁到当前平台 |
| `VITE_PORT` | — | 仅开发服务器端口（默认 9801） |

AI 服务商的设置（Base URL、Key、模型）**不能**通过环境变量配置：它们是 MySQL 里按账号存放的数据，在界面上
编辑。代码里不存在任何 `OPENAI_API_KEY` 查找逻辑。

## 存储布局

```
~/.aetherops/                       # 或 $AETHEROPS_DATA_DIR
├── config.json          0600       # 唯一配置文件；模板自动生成
├── connections.key                  # SSH 密码 / 私钥 / passphrase 的 AES-256-GCM 密钥
├── ai-config.key                    # AI 服务商 API Key 的 AES-256-GCM 密钥
├── server.log                       # 后端日志（控制台输出会同步写到这里）
├── aetherops.server.<port>.pid      # 端口绑定时写入，SIGINT/SIGTERM 时清理
└── .trash/                          # 删除保护的回收入口
    └── _del_<epoch>_<name>
```

`connections.json`、`sessions.json`、`ai-config.json`、`ai-history/`、`audit/*.jsonl` 是上游 AICmd
**过去**的存储形态，现在不再写入：这些数据已经在 MySQL 里了。如果你是从单用户版本迁过来的，目录里可能
还能看到它们。

两个 `.key` 文件只从数据目录读取，**没有**环境变量或 `config.json` 键能提供它们（`AETHEROPS_DATA_DIR`
只能换目录，不能换文件名）。文件不存在时会自动生成一对，所以把服务指向一个已有数据的库、却不带这两个文件，
结果不是报错，而是界面上的口令与 AI Key 全部变成空值 —— 库里旧密文是用旧密钥加密的，只有日志里留下
`Failed to decrypt secret`。换机器、搬进容器、恢复备份，都要把数据目录整体一起搬。

## 表结构与迁移

迁移是 `server/db/migrations/` 下的 TypeScript 模块，由 `server.js` 在绑端口之前按版本号顺序执行。
已应用的版本记录在 `schema_version`（`version`、`name`、`checksum`、`execution_ms`、`applied_at`），
其中 checksum 是对「空白归一化后的语句文本」取 sha256。

| 版本 | 主题 |
|------|------|
| `0001-init` | 业务表：`connections`、`sessions`、`ai_config`、`ai_history`、`ai_messages`、`audit_events`、`skills`、`snippets` |
| `0002-accounts` | `users` 表；每张业务表加 `owner_id`；此前全局唯一的 ID 改成复合主键 |
| `0003-multi-ai` | `ai_config.cost_tier` / `sort_order`；新增 `ai_chats`（按连接划分的会话，各有自己的 `chatId` 与模型绑定） |
| `0004-cost-control` | `cost_tier_source`、`price_in` / `price_out`；新增 `ai_usage`（逐次调用的 token 数，外加调用当时固化的成本快照）与 `ai_budget` |
| `0005-batch-permission` | `users.can_use_batch`，初始值取自 `can_use_terminal`，保证没人丢掉本来就有权限 |
| `0006-system-config` | 新增 `sys_config`（键值对，不分归属）—— 目前只放服务端本机 Shell 的口令哈希 |
| `0007-host-metrics` | 新增 `host_metrics_minute`：每个归属 / 连接 / 分钟一行，记 CPU %、内存 %、磁盘 % 与 load 1/5/15 的均值、峰值与样本数 |
| `0008-connection-sampling` | `connections.sampling`（`''` = 跟随 `metrics.offlineSampling`，`skip` = 无人值守时永不拨号这个连接） |
| `0009-error-fingerprints` | 新增 `error_fingerprints`：每个归属 / 连接 / 指纹一行，记 `occurrences`、`first_seen`、`last_seen`（由 Agent 的 `after_tool` 钩子写入） |
| `0010-alerts` | 新增 `alerts`（有状态告警：`open` / `acked` / `resolved`，靠生成列 `open_key` 按归属 + 连接 + 指纹去重）与 `alert_mutes`（规则级静默窗口） |
| `0011-collaboration` | `alerts.assignee_id` / `alerts.incident_id` 两列，另加 `idx_alerts_assignee` / `idx_alerts_incident`；新增 `incidents`（每个归属 / 连接的事件一行，`open` / `resolved`，`alert_count` 以 alerts 表为准刷新）与 `alert_oncall`（账号 + 一天中的分钟班次，主键 `(owner_id, user_id, start_minute)`） |
| `0012-watch-tokens` | 新增 `auth_watch_tokens`：大屏只读令牌一行一枚（`owner_id`、`label`、`token_hash`、`created_at`、`expires_at`、`revoked_at`、`last_used_at`）。单独一张表而不是塞 Redis，是因为它要能被列出、被单独吊销，并且**不能**挤占「一账号一登录会话」的名额 |

如果你打算加迁移，这些表结构约束值得先知道：

- 目标是 MySQL 8.x，开启 `STRICT_TRANS_TABLES` / `NO_ZERO_DATE`：时间列是 `DATETIME(3) NOT NULL`
  且**不带**数据库侧默认值，由应用提供 UTC 的 `Date`。
- 参考实例上 `lower_case_table_names=0`，因此标识符大小写敏感 —— 约定是全部 snake_case。
- 不用 `ENUM`：默认排序规则 `utf8mb4_0900_ai_ci` 不区分大小写，会把 `privateKey` 和 `privatekey`
  当成同一个值。列用 `VARCHAR` + `CHECK`，取值集合由代码里的常量保证。
- `JSON` / `TEXT` 列不能有默认值，所以要么显式 `NOT NULL`，要么可空。
- 不建外键：现有的删除路径都是纯删除，加级联会改变它们的语义。
- 每条 `ALTER` 都包在 `information_schema` 存在性检查 + `PREPARE` 里，因为 MySQL 没有
  `ADD COLUMN IF NOT EXISTS`，而迁移器的契约是「失败的迁移不登记，下次启动重跑」—— 这要求每条语句
  都可重入。
- `owner_id` 列没有默认值：在严格模式下，漏了归属应当大声失败，而不是静默写入 `''` 造出谁也查不到的行。

命令行：

```bash
pnpm migrate                 # 或者：node scripts/migrate.mjs
node scripts/migrate.mjs --status    # 已应用版本 + 待执行数量
node scripts/migrate.mjs --dump 0002 # 把某个迁移导出成纯 SQL（stdout）
node scripts/migrate.mjs --force     # 忽略 checksum 不一致 / 已应用的检查
```

## 什么数据存在哪儿

| 数据 | 存储位置 | 是否加密 |
|------|----------|----------|
| SSH 连接（主机、用户、认证方式、启动脚本） | MySQL `connections`（按归属隔离） | 密码 / 私钥 / passphrase 为 `enc:v1:` AES-256-GCM |
| 终端会话元数据 | MySQL `sessions` | 否 |
| AI 服务商配置（Base URL、模型、温度、档位、价格） | MySQL `ai_config` | API Key 为 `enc:v1:` |
| 对话与消息 | MySQL `ai_chats`、`ai_history`、`ai_messages` | 否 |
| Token 用量与成本 | MySQL `ai_usage` | 否 |
| 预算上限 | MySQL `ai_budget` | 否 |
| 审计事件（命令、传输、被拦截/被改写） | MySQL `audit_events` | 否 |
| 技能 | MySQL `skills`（用户技能，从技能编辑器写入）+ `<app>/data/skills/*.md`（内置技能） | 否 |
| 命令片段 | MySQL `snippets` | 否 |
| 主机指标历史（每分钟的 CPU / 内存 / 磁盘 / load） | MySQL `host_metrics_minute`（按归属隔离） | 否 |
| 错误指纹（每个归属 / 连接 / 归一化错误一行） | MySQL `error_fingerprints` | 否 |
| 告警、规则级静默、事件与值班表 | MySQL `alerts`（含 `assignee_id` / `incident_id`）、`alert_mutes`、`incidents`、`alert_oncall`（按归属隔离） | 否 |
| 账号（scrypt 哈希、角色、状态、10 个权限位） | MySQL `users` | 只存口令哈希，不可逆 |
| 登录令牌 | Redis（`aetherops:token:*`，哈希存储，滑动 TTL） | 不适用 |
| 大屏只读令牌 | MySQL `auth_watch_tokens`（按归属隔离，存 SHA-256 哈希） | 不适用；明文只在签发响应里出现一次 |
| 解密密钥 | 数据目录下的 `*.key` 文件 | 这些**就是**秘密本身 |
| 服务日志、PID 文件、回收站 | 数据目录 | 否 |

实际影响：

- 只备份数据库不会泄露凭据；`.key` 文件会。任何离开本机的导出都要把它们排除在外，并且与数据库分开备份。
- 同时拿到 MySQL 和数据目录的人可以读出所有存下来的 SSH 凭据。这是凭据管理器的常规威胁模型，两边都要按
  这个前提保护。
- 活着的终端会话是进程内状态。重启服务会把它们关掉；持久化的元数据能让界面恢复标签页，但恢复不了 shell 本身。

## 备份与搬迁

两半要一起备份：

```bash
mysqldump --single-transaction aetherops | gzip > aetherops-db.sql.gz
tar czf aetherops-data.tar.gz -C ~ .aetherops
```

在别处恢复时需要同样的 `schema_version` 行（它们随 dump 一起走），所以不要手改已应用的迁移。搬迁数据目录
时保留文件权限：`config.json` 应当是 `0600`。

旧数据说明：如果存在 `~/.aicmd` 且 `~/.aetherops` 为空，首次启动会把它搬过去（跨设备时退化为复制，并把原目录留成
`~/.aicmd.migrated.bak`）。`.key` 文件跟着一起搬，所以已保存的凭据搬迁后仍可解密。设置了 `AETHEROPS_DATA_DIR`
则完全不做搬迁。
