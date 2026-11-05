# 账号、角色与权限

[English](./accounts-and-permissions.md) · **简体中文**

AetherOps 天生就是多账号的：它把一台真实服务器的 shell（连同自然语言驱动）交给 AI Agent，所以
「谁被允许做哪件危险的事」从一开始就是一等公民问题，而不是事后补的。

- [模型](#模型)
- [十个权限位](#十个权限位)
- [注册与授权](#注册与授权)
- [令牌与会话](#令牌与会话)
- [数据隔离](#数据隔离)
- [管理员代管](#管理员代管)
- [凭据处理](#凭据处理)
- [改动规则](#改动规则)

## 模型

| 概念 | 取值 | 说明 |
|------|------|------|
| `role` | `admin`、`user` | `admin` 管理账号，并可使用代管类接口。它**不是**普通功能的权限位豁免 |
| `status` | `pending`、`active`、`disabled` | `pending` 可以登录但只看到「等待授权」状态；`disabled` 完全登不进来 |
| `permissions` | 10 个布尔值 | 每个请求、每个接口都会校验 |
| `username` | `[A-Za-z0-9_.-]{3,32}` | |
| `displayName` | 自由文本，截断到 64 | |
| `password` | 8–128 位，`scrypt` 哈希 | 格式 `scrypt$N$r$p$salt$hash` |

初始管理员在 `users` 表为空时创建：用户名 `admin`，随机 16 位密码（已排除易混淆字符），只在启动日志里
打印一次。除此之外没有任何预置账号，也不存在默认密码。

## 十个权限位

| 权限位 | 授予的能力 | 数据库列 |
|--------|------------|----------|
| `terminal` | 打开并操作 SSH/本地终端 | `can_use_terminal` |
| `batch` | 把一条命令同时下发到多个会话 | `can_use_batch` |
| `ai` | 与 Agent 对话、运行会执行命令的技能 | `can_use_ai` |
| `connections` | 新建/编辑/删除保存的连接 | `can_manage_connections` |
| `aiConfig` | 读取与修改 AI 服务商配置 | `can_configure_ai` |
| `files` | SFTP 文件管理器与传输 | `can_use_files` |
| `monitor` | 日志监控与告警 | `can_view_monitor` |
| `audit` | 查看审计历史 | `can_view_audit` |
| `skills` | 列出与查看技能 | `can_manage_skills` |
| `snippets` | 命令片段库 | `can_manage_snippets` |

接口到权限的映射集中在 `server/index.ts` 的一张表里（精确路径走 `EXACT_PERMISSIONS`，前缀匹配走
`PREFIX_PERMISSIONS`）。提 bug 之前值得先理解的几条语义：

- **是「任一满足」而不是「全部满足」**：有些接口接受多个权限位中的任意一个，因为文件管理器和终端共用
  同一条底层 SSH 会话 —— 只有 `files` 没有 `terminal` 的人也应该能浏览目录。
- **未登记的接口只要求登录。** 兜底策略刻意是「宁可少拦，不可拦错」，所以一个没登记的新接口任何登录用户
  都能访问。你加接口时，就必须同时把它加进这张表。
- **`batch` 是从 `terminal` 里拆出来的**（迁移 `0005`），因为「一条命令打向 N 台主机」的爆炸半径大得多。
  存量账号只有在已经拥有终端权限时才会继承 `can_use_batch = 1`；如果你想要更紧的默认值，在管理界面按账号
  收回即可。
- **会话归属是另外一道校验**：任何带 `sessionId` 的请求，只要这个活着的会话属于别人，就直接拒绝，与权限位
  无关。终端 ID 由客户端生成，所以靠猜 ID 买到别人的 shell 这条路必须堵死。

## 注册与授权

拿到账号有两条路径：

1. **自助注册**（登录页上的链接）：建出来的是 `role=user`、`status=pending`、**权限全关**。这个人可以登录
   然后等待；在管理员授予权限位之前，什么都用不了。对于注册链接对外开放的共享部署，这是安全默认值。
2. **管理员创建**：直接 `status=active`，权限集合由你指定；密码留空的话会生成一个随机密码，并且只在响应里
   展示一次。

`/api/auth/register` 在公开路径白名单里，而且**没有任何配置开关可以关闭注册**。`pending` 账号什么都干不了，
所以这不是权限漏洞；但它确实意味着任何能访问到服务的人都能往你的 `users` 表里插行、并且能知道某个用户名是否
已存在。对于网络可达范围超出你自有网络的实例，请在反向代理上封掉 `/api/auth/register`，改由管理员建账号。

管理员在 **账号菜单 → 用户管理**（`/users`，仅管理员可访问的路由）可以：

- 修改显示名、角色、状态以及权限勾选框；
- 重置密码（生成一个新的）；
- 删除账号；
- 强制某个用户下线。

有两道保险防止你把自己锁在门外：

- 管理员通过更新接口修改**自己**账号时，不能改自己的 `role` 或 `status`（只能改显示名和权限），所以
  「自降身份然后丢掉管理控制台」不是一键就能发生的事；
- **最后一个可用管理员**不能被降权或停用 —— 请求会以 409 失败。

## 令牌与会话

```
POST /oauth/token   grant_type=password  → access_token, expires_in, user (permissions snapshot)
POST /api/auth/login                      → same handler, JSON or form encoded
POST /oauth/revoke                        → revoke current token (logout)
POST /api/auth/me                         → re-read the account row (fresh permissions)
POST /api/auth/register                   → self-service signup, lands as pending
POST /api/auth/changePassword             → change own password, then forces re-login
POST /api/users/*                         → admin-only account management
```

JSON 业务路由**只接受 POST**：`app.use('/api/')` 里处理 `POST`，其他方法一律 `next()`，所以
`GET /api/connections` 会穿透到 SPA 前端路由，而不是返回数据。三个文件传输接口
（`/api/file-upload`、`/api/cwd`、`/api/file/download`）是注册在该中间件之前的独立 HTTP 路由，因为它们
传输的是二进制负载而不是 JSON，并且各自做权限校验 + 会话归属校验。`/oauth/token` 的响应带
`Cache-Control: no-store`，避免中间设备缓存并重放令牌。

- 令牌形如 `ao_` + 32 随机字节（base64url）。Redis 里只存令牌的**哈希**作为键，值是负载
  （userId、role、status、权限快照）。
- TTL 是 7200 秒，**滑动续期**：每个已认证请求在剩余不足 1000 秒时把它延长，续期与账号索引更新写在同一个
  Lua 脚本里，因此续期不会有竞态。
- **一个账号只有一个活跃会话**：签发新令牌会原子地删掉旧的。在另一台机器上第二次登录会把第一个踢掉；
  前端能区分这种情况（`session_replaced`）和普通的过期。
- 管理员任何影响「这个会话还能不能用」的改动（角色 / 状态 / 权限）都会立即吊销目标的令牌，因为令牌里带的是
  快照 —— 否则会话会继续用过期权限跑下去。
- 用户名不存在时，口令校验也会对一个哑哈希执行一次 scrypt，所以「账号不存在」和「密码错误」耗时接近、返回
  同一句提示。
- WebSocket 用同一个令牌（`/ws/terminal` 上的 `?token=`，因为浏览器在那里设不了请求头）。在创建任何会话
  之前，握手会依次检查**来源白名单**、令牌，然后要求 `terminal` 权限，任一失败以 `1008` 关闭。在（可能是远程
  的、较慢的）Redis 查询期间到达的消息会被缓冲并按序回放，而不是丢弃；消息里的每个 `sessionId` 都会做归属
  校验 —— 只有 `create` 例外。
- 删除账号（管理员操作）会吊销其令牌、**清理该归属下的所有数据行**并删除用户记录。账号没有软删除也没有
  回收站，因此这个操作不可逆。

## 数据隔离

每一条业务查询都显式接收 `owner_id`。服务实例上不存在「当前用户」这种状态 —— 服务是进程级全局的、被所有
账号共用，一个隐式的「当前用户」会把上一个请求的身份泄漏出来。

具体地：连接、会话、AI 配置、对话、消息、用量、预算、审计事件、命令片段、用户技能，全都以账号为键。两个账号
看不到彼此的服务器、提示词或对话记录，即使它们共用同一个 MySQL 库。

## 管理员代管

管理员可以**查看**成员的数据。这是隔离性唯一一处刻意的例外，因此它被限制在显式做角色校验的接口上（不是走通用
权限表），并且每个接口都要求传入 `userId`：

| 接口 | 返回内容 |
|------|----------|
| `/api/admin/memberAudit` / `memberAuditDates` | 某个成员的命令审计轨迹 |
| `/api/admin/memberTransfers` | 文件上传/下载记录（路径、字节数、耗时、结果） |
| `/api/admin/memberConnections` | 连接清单 —— **`password` / `privateKey` / `passphrase` 会被剥掉**，只留一个 `hasSecret` 标记 |
| `/api/admin/memberSessions` | 某个成员当前活着的终端会话 |
| `/api/admin/disconnectUser` | 关闭某个成员的全部会话 |

如果你要扩充这一组接口，请守住剥离规则：凭据材料绝不能出现在非本人的视图里。一份会泄漏凭据的代管清单，会把
治理能力本身变成一处暴露面。

## 凭据处理

| 秘密 | 静态存储形态 | 密钥位置 |
|------|--------------|----------|
| 账号口令 | `scrypt` 哈希，不可逆 | 不适用 |
| SSH 密码、私钥、passphrase | MySQL 中的 `enc:v1:` AES-256-GCM | `~/.aetherops/connections.key` |
| AI 服务商 API Key | MySQL 中的 `enc:v1:` AES-256-GCM | `~/.aetherops/ai-config.key` |
| 登录令牌 | 以 SHA-256 哈希作为 Redis 键 | 不适用 |

需要提前规划的后果：

- `.key` 文件才是秘密本身。要备份它们，并且别混进数据库导出里。
- 数据目录丢了，等于存下来的凭据全丢（无法再解密）。
- 一份数据库 dump 加上数据目录，就等于存好的 SSH 凭据全部暴露 —— 这是凭据管理器的常规权衡，两半都要保护。

## 改动规则

如果你要改授权行为：

1. 权限校验保持在 `assertPermission` / `assertAdmin` / `assertSessionOwner` 里 —— 一个漏斗，而不是散落在
   各个 service 里的 `if`。
2. 新业务表必须把 `owner_id` 放进主键（或等价的归属列），并且**不设默认值**，这样漏传归属会大声失败，
   而不是写进一批谁也读不到的行。
3. 迁移必须可重入（`ALTER` 要包在 `information_schema` 存在性检查 + `PREPARE` 里）：迁移器会在下次启动
   重跑失败的迁移。
4. 对着运行中的实例执行 `node scripts/verify-auth.mjs`，它就是登录、pending 限制、权限强制、数据隔离、
   单点登录抢占、滑动续期、删号即失效的回归网。碰到以上任何一块，都要跑一遍。
5. 不要新增任何可以关闭认证的途径。旧的 `auth.disabled` / `auth.accessToken` 是被刻意废弃并告警的；本地
   开发同样使用真实账号。
