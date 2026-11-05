# 快速上手

[English](./getting-started.md) · **简体中文**

这篇走查带你从一台空机器一路走到「AI Agent 在真实服务器上执行命令」。假设你是给自己或一个小团队部署。
MySQL 与 Redis 已经可连通的话，整体大约 15 分钟。

- [0. 前置要求](#0-前置要求)
- [1. 安装与构建](#1-安装与构建)
- [2. 准备 MySQL 与 Redis](#2-准备-mysql-与-redis)
- [3. 配置服务端](#3-配置服务端)
- [4. 首次启动与引导出的管理员](#4-首次启动与引导出的管理员)
- [5. 建立第一个 SSH 连接](#5-建立第一个-ssh-连接)
- [6. 配置 AI 服务商](#6-配置-ai-服务商)
- [7. 第一次对话](#7-第一次对话)
- [8. 可选：加入团队成员](#8-可选加入团队成员)
- [下一步](#下一步)

## 0. 前置要求

| 组件 | 最低要求 | 原因 |
|------|----------|------|
| Node.js | 22.17 | Agent 引擎声明了 `engines: { node: '>=22.17.0' }` |
| pnpm | 10.x | 锁文件是 pnpm 10 的形状，见 [CONTRIBUTING.md](../CONTRIBUTING.md#dependency-pinning) |
| MySQL | 8.x | 硬依赖 |
| Redis | 较新版本 | 硬依赖（登录令牌存放处） |
| C++ 工具链 | gcc/clang 或 VS Build Tools | node-pty、ssh2、cpu-features 是原生模块 |

## 1. 安装与构建

```bash
git clone https://github.com/SubDong/AetherOps.git
cd AetherOps
npm i -g pnpm@10        # 或者：corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 先跑钉版校验，然后把前端打包到 `dist/public`、把 `server/` 编译到 `dist/server`。
如果钉版校验失败，说明你装出来的依赖树和锁文件不一致 —— 请用 `pnpm install --frozen-lockfile`
重装，而不是手改版本号。

pnpm 必须显式装 10 这个大版本。只执行 `corepack enable` 不够：本仓库刻意**没有** `packageManager`
字段（原因见 [CONTRIBUTING.md](../CONTRIBUTING.md#dependency-pinning)），corepack 因此会解析到它自己
认为的当前大版本，而 pnpm 11/12 装出来的锁文件形状会被 CI 的 pnpm 10 直接拒绝。

## 2. 准备 MySQL 与 Redis

建库并建一个最小权限账号：

```sql
CREATE DATABASE aetherops CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'aetherops'@'%' IDENTIFIED BY 'change-me';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON aetherops.* TO 'aetherops'@'%';
```

应用会自己建表并做表结构迁移，上面那些额外权限就是给它做这件事用的。如果你的规约不允许应用持有 DDL，
可以改为导出 SQL 交给 DBA 执行：

```bash
node scripts/migrate.mjs --dump 0001 > 0001.sql   # 每个迁移版本各导一次
```

Redis 只要能连通就行，不需要任何初始化。只要它没有绑定在 localhost 上，就强烈建议设置密码（或 ACL 用户），
因为登录令牌就存在这里。项目不使用任何 Redis module。

## 3. 配置服务端

首次运行时，服务端会在 `~/.aetherops/config.json` 落一份权限为 `0600` 的模板。下面这份是**节选**——
真实文件里的键比这三组更多：

```json
{
  "server":   { "port": 9802, "host": "127.0.0.1" },
  "database": { "host": "", "port": 3306, "user": "", "password": "", "database": "aetherops" },
  "redis":    { "url": "", "host": "", "port": 6379, "password": "", "db": 0, "keyPrefix": "aetherops:" },
  "auth":     { "launchToken": "", "maxUploadMb": 100 },
  "debug":    { "sshDebug": false }
}
```

填好 `database` 与 `redis` 两段 —— 或者让这两段留空、改用环境变量提供，这样凭据不落盘：

```bash
export AETHEROPS_DB_HOST=127.0.0.1
export AETHEROPS_DB_USER=aetherops
export AETHEROPS_DB_PASSWORD='change-me'
export AETHEROPS_DB_NAME=aetherops
export AETHEROPS_REDIS_HOST=127.0.0.1
export AETHEROPS_REDIS_PASSWORD='redis-secret'
```

优先级是：内置默认值 < 配置文件 < 环境变量。要绑定 `0.0.0.0` 用 `HOST=0.0.0.0`，
而这只有在你已经上了认证、并且网络归你控制时才讲得通。

完整参考见 [configuration.zh.md](./configuration.zh.md)。

## 4. 首次启动与引导出的管理员

```bash
node server.js
```

启动顺序是刻意设计的：校验配置 → 连 MySQL → 执行迁移 → 探活 Redis → 初始化服务 → 最后才绑端口。
缺依赖时会带着一句可读的报错退出，而不是把一个「每个请求都报错」的端口开出来。

`users` 表为空时，系统会替你创建好一个管理员账号。它的密码是随机的、**只打印一次**，
除了日志之外不存在于任何文件：

```
[Auth] 已创建初始管理员  admin / <16 位随机密码>
```

从控制台或 `~/.aetherops/server.log` 里把这行拿到，打开日志打印的地址（默认
<http://127.0.0.1:9802>），用 `admin` 登录，然后**立刻**改密码（账号菜单 → 修改密码）。

底下的账号模型长什么样，见 [accounts-and-permissions.zh.md](./accounts-and-permissions.zh.md)。

## 5. 建立第一个 SSH 连接

1. 在左侧边栏选择 **连接 → 新建**（管理员在代管其他成员的连接清单时，用的是同一个对话框）。
2. 填主机、端口、用户名。认证方式可以是密钥、口令，或自动判断。
   - 密钥：粘贴私钥，可选带 passphrase。私钥以 `enc:v1:` 前缀的 AES-256-GCM 密文存进 MySQL，
     解密用的密钥留在 `~/.aetherops/connections.key`。
   - `connections.key` **不会**备份进数据库 —— 数据目录丢了，等于存好的凭据全丢。请务必备份该目录。
3. 保存前先用内置的测试按钮验一次连通性。
4. 走跳板机的话，加一段**启动脚本**（`ssh user@target.internal`）并勾上 **SSH Agent 转发**：
   见 [jump-host.zh.md](./jump-host.zh.md)。

打开连接后会出现一个多标签终端。标签栏上的工具条可以唤出 SFTP 文件管理器、命令片段面板，以及
**服务器状态**面板（可以停靠到侧边栏，也可以悬浮）。

## 6. 配置 AI 服务商

Agent 至少需要一套模型配置。打开 AI 设置（对话头部的齿轮图标，或侧边栏底部的机器人图标）。

- 服务商：**OpenAI**、**Anthropic (Claude)**、**腾讯云**、**Azure OpenAI**，或 **自定义** ——
  任何 OpenAI 兼容端点（DeepSeek、Qwen、自建网关……）填 Base URL + 模型名即可。
- 每个账号可以保存**多套配置**并打上标签，标签就是模型选择器里显示的内容。
- 保存前先点**测试**：它会真的向该端点发一次补全请求。
- 给每套配置设一个**成本档位（1 最便宜 … 5 最强）**，或者留在自动档、让定价目录来判：
  见 [ai-models-and-cost.zh.md](./ai-models-and-cost.zh.md)。
- API Key 的静态加密方式和 SSH 凭据完全一致。

## 7. 第一次对话

终端标签处于焦点状态时，AI 面板就绑定在这个会话上 —— 命令会真的在它上面执行。

```
看看 nginx 在不在跑，把它错误日志里最近的报错给我
```

Agent 会先识别操作系统家族，再挑平台合适的命令（`systemctl` / `launchctl` / `Get-Service`），
读回输出，然后继续迭代。可以试试：

- `/server-health-check` —— 内置技能，系统性地把各项指标采集一遍
  （见 [skills-guide.zh.md](./skills-guide.zh.md)）
- 「清理 7 天之前的 Docker 镜像，并告诉我释放了多少空间」
- 「现在哪个进程在吃内存？」—— 预期它生成一段脚本，而不是连敲五条命令

每条命令都会进审计面板，被安全层拦截或改写的同样进（危险的删除会被改写成移动到
`~/.aetherops/.trash/`）。

如果 Agent 回答「没有终端会话」，意思是 AI 面板当时没有绑定到一个活着的会话 —— 先打开或重连一个终端。
这是刻意为之：它宁可停下来，也不会编造输出。

## 8. 可选：加入团队成员

登录页上有**注册**入口。自助注册出来的账号状态是 `pending`、权限位全关，所以任何人都能申请账号，
但没人能直接用一个没被批准的账号。管理员打开 **账号菜单 → 用户管理**（`/users`）可以：

- 批准一个账号（状态改成 `active`），或者直接用生成的随机密码把账号建出来；
- 只授予这个人需要的权限位（`terminal`、`batch`、`ai`、`connections`、`aiConfig`、`files`、
  `monitor`、`audit`、`skills`、`snippets`）；
- 重置密码、强制下线，或删除账号；
- 查看某个成员的审计记录、文件传输记录、连接清单（凭据被剥掉）与在线会话，必要时把他踢下线。

连接、对话历史、AI 配置、命令片段、审计记录都按账号隔离：成员之间互相看不到数据，只有 `admin`
能够访问代管类接口。

## 下一步

| 你想做的事 | 看哪篇 |
|------------|--------|
| 用 Docker 跑在服务器上 | [deployment.zh.md](./deployment.zh.md) |
| 每个配置键与环境变量的完整清单 | [configuration.zh.md](./configuration.zh.md) |
| 弄清 Agent 能做什么、不能做什么 | [../SECURITY.md](../SECURITY.md)、[accounts-and-permissions.zh.md](./accounts-and-permissions.zh.md) |
| 降低 AI 开销 | [ai-models-and-cost.zh.md](./ai-models-and-cost.zh.md) |
| 出问题了 | [troubleshooting.zh.md](./troubleshooting.zh.md) |
