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

### `debug`

| 键 | 默认值 | 含义 |
|----|--------|------|
| `sshDebug` | `false` | 把 ssh2 协议层的 debug 输出转发到前端的终端里 |

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
| `AETHEROPS_LAUNCH_TOKEN` | `auth.launchToken` | 由桌面/VSCode 宿主设置 |
| `AETHEROPS_SSH_DEBUG` | `debug.sshDebug` | `1` 或 `true` |
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
| 技能 | MySQL `skills`（用户技能）+ `<app>/data/skills/*.md`（内置技能） | 否 |
| 命令片段 | MySQL `snippets` | 否 |
| 账号（scrypt 哈希、角色、状态、10 个权限位） | MySQL `users` | 只存口令哈希，不可逆 |
| 登录令牌 | Redis（`aetherops:token:*`，哈希存储，滑动 TTL） | 不适用 |
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
