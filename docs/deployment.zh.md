# 部署

[English](./deployment.md) · **简体中文**

AetherOps 就是一个 Node 进程，外加**两个硬依赖：MySQL 8.x 与 Redis**。没有「单机免依赖」模式 ——
只要这两个依赖连不上，进程就拒绝绑定端口，所以给这两个服务做容量规划是部署的一部分，不是事后想起来再补的。

- [渠道一览](#渠道一览)
- [前置要求](#前置要求)
- [准备 MySQL 与 Redis](#准备-mysql-与-redis)
- [源码构建](#源码构建)
- [Docker](#docker)
- [反向代理与 TLS](#反向代理与-tls)
- [作为服务运行](#作为服务运行)
- [升级与回滚](#升级与回滚)
- [桌面端与 VS Code 打包](#桌面端与-vs-code-打包)
- [CI/CD 发版流程](#cicd-发版流程)
- [给 fork 的说明](#给-fork-的说明)
- [运维安全](#运维安全)

## 渠道一览

| 渠道 | 适用于 | 备注 |
|------|--------|------|
| 源码构建 | 开发、定制构建、自己脚本化的离线交付 | `pnpm install --frozen-lockfile` + `pnpm build-only` |
| Docker | 服务器部署、团队共享实例 | 镜像里只有应用；MySQL 和 Redis 由你提供 |
| Docker Compose（应用 + 数据库 + 缓存） | 单机试用或小团队 | 下面推荐的起步方案 |
| Electron 桌面端 | 想要原生窗口的个人用户 | 自带后端；仍然需要这台机器能访问到 MySQL 和 Redis |
| VS Code 插件 | 在 VS Code 里用终端 | 插件里打包了后端运行时；同样的依赖规则 |
| npm 全局安装 | **未发布** | 根 `package.json` 是 `"private": true`。请从源码或发版产物安装 |

桌面端和 VS Code 这两个渠道很方便，但它们并没有去掉服务端依赖：每个用户仍然需要一个 MySQL 库和一个 Redis
实例。对团队来说，正确做法是跑一个 Web 实例，让大家把桌面端/VS Code 指向它，或者指向同一个共享数据库。

## 前置要求

| 组件 | 版本 | 为什么是这个下限 |
|------|------|------------------|
| Node.js | **>= 22.17.0** | 由 `@cicctencent/agent-core`（Agent 引擎）要求。Docker 和 CI 都用 Node 22 |
| pnpm | **10** | CI、Docker 镜像、钉版检查全都用 10。`pnpm-workspace.yaml` 放着原生模块的构建白名单（10/11 用 `onlyBuiltDependencies`，12+ 用 `allowBuilds`）以及 zmodem 补丁；`package.json#pnpm` 为旧版 pnpm 镜像了其中关键的几项。被 pnpm 11/12 重写过的锁文件会让 CI 的 `--frozen-lockfile` 以 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 失败 |
| MySQL | 8.x | 迁移假设了 `utf8mb4_0900_ai_ci`、`STRICT_TRANS_TABLES`、`DATETIME(3)` |
| Redis | 6+（任意近期版本） | 登录令牌存储；`keyPrefix` 让你可以共用一个实例 |
| C++ 工具链 | 用于原生模块 | `node-pty`、`ssh2`、`cpu-features` 需要执行构建脚本：Linux `python3 make g++`，macOS Xcode CLT，Windows VS Build Tools |

构建链是刻意钉死的：`pnpm run check-pin`（由 `build-only` 自动执行）会在 `@cicctencent/agent-core` 或
`vite` 被声明成版本区间、或与实际安装不一致时让构建失败。见
[CONTRIBUTING.md](../CONTRIBUTING.md#dependency-pinning)。

## 准备 MySQL 与 Redis

建库并建一个应用账号。应用会在启动时自己跑迁移，所以这个账号需要该库的 DDL 权限；如果你更愿意自己执行
SQL（`node scripts/migrate.mjs --dump 0001` 之类），那么一个只有 DML 的账号就够了。

```sql
CREATE DATABASE aetherops CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'aetherops'@'%' IDENTIFIED BY 'change-me';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON aetherops.* TO 'aetherops'@'%';
FLUSH PRIVILEGES;
```

Redis：如果这个实例的可达范围超出 localhost，请设置 `requirepass`；如果它与其他应用共用，请挑一个合理的
`db` 并加上 `keyPrefix`（默认前缀是 `aetherops:`）。Redis 是否持久化是一个延迟问题，不是正确性问题 ——
令牌本来就是短命的，丢了意味着用户重新登录一次。

曾经咬过人的几件事：

- **连接池大小**：`database.connectionLimit` 默认是 `5`，不是 10，因为一个 `max_connections=50` 的共享
  MySQL 扛不住每台应用进程占 10 条连接。要横向扩展之前，先把算术做完。
- **时区**：应用写入的是 UTC 的 `Date` 值，且从不使用 `NOW()`，因为当初那台参考实例的
  `system_time_zone=CST`，结果所有时间整体偏了 8 小时。除非你清楚会改变什么，否则 `database.timezone`
  请保持 `+00:00`。
- **TLS**：Ubuntu 的 MySQL 自带一张没有 CA 的自签证书，因此严格校验默认就是失败的；
  `sslRejectUnauthorized: false` 给你的是加密但不防中间人的连接。某些 TLS 密钥组合会导致启动直接失败，
  而不是被静默忽略。

所有配置键与环境变量都列在 [configuration.zh.md](./configuration.zh.md) 里。

## 源码构建

```bash
git clone https://github.com/SubDong/AetherOps.git
cd AetherOps

pnpm install --frozen-lockfile
pnpm run build-only          # 钉版检查 → vite build → tsc -p tsconfig.server.json

# 指向你的 MySQL/Redis（配置文件或环境变量都行）
export AETHEROPS_DB_HOST=127.0.0.1
export AETHEROPS_DB_USER=aetherops
export AETHEROPS_DB_PASSWORD='change-me'
export AETHEROPS_REDIS_HOST=127.0.0.1

node server.js                       # 默认 127.0.0.1:9802
node server.js --port 3000
```

`server.js` 从 `dist/` 启动后端 —— 在跑过 `build-only` 之前执行它会以
`[ERROR] 找不到 server 构建产物` 退出。第一次成功启动时，它会创建 `~/.aetherops/config.json`
（权限 `0600`）、应用迁移，并把初始管理员打印**一次**：

```
[Auth] 已创建初始管理员  admin / <随机 16 位口令>
```

请抓住这一行；它不会重复出现，也没有离线的口令重置命令。登录进去，建一个真正的管理员账号，然后把 `admin`
留作一把「破窗」凭据并禁用它，或者直接删掉。

验证实例行为正常：

```bash
node scripts/migrate.mjs --status   # 已应用版本 + 待执行数量
node scripts/verify-auth.mjs        # 登录、pending、权限、隔离、单会话、删号
```

`pnpm run smoke`（`scripts/smoke-terminal.mjs`）会驱动终端整条链路，但它目前还不带 bearer token，
所以在启用了账号体系的实例上，它会在第一个 API 调用处拿到 401 就停下。端到端验证请用
`verify-auth.mjs`；教会 smoke 脚本先登录是一个很有价值的贡献 —— 见
[CONTRIBUTING.md](../CONTRIBUTING.md#test-scripts)。

## Docker

镜像是两阶段构建（构建和运行都用 `node:22-slim`，两个阶段里都是 pnpm 10），里面只有应用。MySQL 和 Redis
**不在**其中。

### 一条命令

```bash
pnpm docker:build           # → aetherops:<package.json 里的版本> + aetherops:latest
```

[`scripts/docker-build.mjs`](../scripts/docker-build.mjs) 包了一层 `docker build`，目的是把那些「事前就能看出
来的失败」在构建开始前就报出来，而不是跑到第五层才炸：

- Dockerfile 要 `COPY` 的文件（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches`）必须在；
- daemon 必须能回 `docker version`，而且报错是 daemon 原话，不是一屏堆栈；
- `.dockerignore` 必须真的排掉磁盘上那些很重的本地产物（`node_modules`、`dist*`、`release`、
  `packages/vscode/runtime`、`*.vsix`）—— 因为 `COPY . .` 会把它们全送进构建上下文，而一份陈旧的、
  原生模块已编译好的 `node_modules` 与一份 `--frozen-lockfile` 装出来的依赖混在一起，这个镜像就没人说得清
  是哪一份了；
- 每个产出的 tag 都带 OCI label（`image.title`、`image.version`、`image.revision`、`image.created`），
  这样跑着的容器能反查它是从哪次提交构建的；工作树不干净时会提醒一句，因为那时候没有任何一次提交对得上字节。

你没点名的 flag 原样透传给 `docker build`：

```bash
pnpm docker:build -- --tag registry.example.com/team/aetherops --version 1.0.27 --push
pnpm docker:build -- --platform linux/amd64       # 交叉构建：自动改成 buildx + --load
pnpm docker:build -- --no-cache --pull --dry-run  # --dry-run 只打印命令就退出
```

`--dry-run` 故意不要求 daemon 在跑，所以 Docker Desktop 关着的时候也能先看一遍要执行什么。

手写 `docker build` 仍然可行 —— 包装脚本执行的正是它：

```bash
docker build -t aetherops .

docker run -d \
  --name aetherops \
  -p 127.0.0.1:9802:9802 \
  -e AETHEROPS_DB_HOST=172.17.0.1 \
  -e AETHEROPS_DB_USER=aetherops \
  -e AETHEROPS_DB_PASSWORD='change-me' \
  -e AETHEROPS_REDIS_HOST=172.17.0.1 \
  -v aetherops-data:/root/.aetherops \
  aetherops
```

值得知道的镜像事实：

- `HOST=0.0.0.0` 是被烧进镜像里的（容器必须接受外部连接），而直接源码运行绑定的是 `127.0.0.1`。除非你
  前面已经有 TLS 和访问控制，否则请把端口只发布到 localhost。
- 声明了 `VOLUME /root/.aetherops`，所以忘了写 `-v` 时数据会落在一个匿名的命名卷里，而不是容器的可写层
  —— 比彻底丢掉安全，但备份起来仍然别扭。生产环境请显式绑定一个卷或路径。如果你设置了
  `AETHEROPS_DATA_DIR`，那就挂载*那个*路径。
- `data/skills` 会被复制到 `/app/data/skills`，因为内置技能是从
  `process.cwd()/data/skills` 读取的 —— 不是从数据目录。漏掉这一步，产出的镜像技能列表就是空的。
- `TZ=Asia/Shanghai` 只是容器的时钟标签；数据库里的时间戳是按 UTC 写入的。
- 构建期的镜像源（Debian 用阿里云、pnpm 与 Electron 用 npmmirror）配置在 Dockerfile 里。如果你在别的
  区域构建，请改那几行；它们在运行期不影响任何东西。

### 用 Docker Compose 一起拉起 MySQL 与 Redis

这是在一台机器上得到可用实例的最短路径。这**不是**高可用方案 —— 单实例约束见
[给 fork 的说明](#给-fork-的说明)。

```yaml
services:
  aetherops:
    build: .
    ports:
      - "127.0.0.1:9802:9802"
    environment:
      AETHEROPS_DB_HOST: mysql
      AETHEROPS_DB_PORT: "3306"
      AETHEROPS_DB_USER: aetherops
      AETHEROPS_DB_PASSWORD: change-me
      AETHEROPS_DB_NAME: aetherops
      AETHEROPS_REDIS_HOST: redis
      AETHEROPS_REDIS_PORT: "6379"
      AETHEROPS_REDIS_PASSWORD: change-me-redis
    volumes:
      - aetherops-data:/root/.aetherops
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  mysql:
    image: mysql:8.4
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
    environment:
      MYSQL_ROOT_PASSWORD: change-me-root
      MYSQL_DATABASE: aetherops
      MYSQL_USER: aetherops
      MYSQL_PASSWORD: change-me
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-pchange-me-root"]
      interval: 10s
      timeout: 5s
      retries: 12
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass change-me-redis
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "change-me-redis", "ping"]
      interval: 10s
      timeout: 5s
      retries: 12
    restart: unless-stopped

volumes:
  aetherops-data:
  mysql-data:
  redis-data:
```

```bash
docker compose up -d
docker compose logs -f aetherops     # 盯住 [Auth] 初始管理员那一行
```

如果 MySQL 因为账号缺少 DDL 权限而拒绝连接，请先自己应用迁移（用一份指向同一个库的源码检出执行
`node scripts/migrate.mjs`），然后再重启应用。

## 反向代理与 TLS

代理配置不对时会坏两件事：WebSocket（`/ws/terminal` 承载每一个终端字节），以及来源白名单 ——
服务端只在 `Origin` 的主机名与 `Host` 头相等（或者是 localhost）时才接受请求，因此把 host 剥掉会导致
到处都返回 `403 Forbidden origin`。

```nginx
server {
    listen 443 ssl http2;
    server_name aetherops.example.com;

    ssl_certificate     /etc/letsencrypt/live/aetherops.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aetherops.example.com/privkey.pem;

    client_max_body_size 120m;   # 必须 >= auth.maxUploadMb（默认 100）

    location / {
        proxy_pass http://127.0.0.1:9802;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;           # 来源校验需要它
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                   # AI 回复是流式的
        proxy_read_timeout 3600s;              # 空闲终端不能被切断
    }
}
```

`X-Forwarded-For` 只是作为审计上下文被记录下来；应用不会解析它来做任何信任判断，所以不要把它当作访问控制的
输入来依赖。

## 作为服务运行

让这个进程保持存活有三种做法；选一种，不要在同一个端口上混用。

**自带的 CLI**（`bin/aetherops.js`，通过 `bin` 字段以 `aetherops` 暴露）会自己 fork 一个子进程，并用
按端口区分的 PID 文件跟踪它：

```bash
aetherops start [-p 9802]     # 需要 dist/ —— 先构建
aetherops stop | restart | -v
```

它把控制台输出追加到 `~/.aetherops/server.log`，会打开浏览器，并且 —— 对服务器来说很关键 ——
如果端口被占用，它会**不断递增直到找到一个空闲端口**，而不是失败。在一个期待 9802 的反向代理后面，这就把一次
端口冲突变成了一个悄无声息的错误上游，所以请核对它打印出来的 URL。当 PID 文件缺失时，`stop` 会退回到按端口
查归属（Windows 用 `netstat`，其他系统用 `lsof`），因此它也可能指向一个并不是它自己启动的进程。

**pm2** 是 `pnpm start` / `stop` / `restart` 这几个脚本包装的东西（进程名 `aetherops-server`），
如果你本来就以这种方式跑 Node 服务，这是最快的选择：

```bash
pnpm start -- --port 9802
pm2 logs aetherops-server
```

**systemd** 不需要任何特殊处理，因为这个应用就是一个普通的前台 Node 进程：

```ini
[Unit]
Description=AetherOps
After=network-online.target mysql.service redis.service

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=AETHEROPS_DB_HOST=127.0.0.1
Environment=AETHEROPS_DB_USER=aetherops
Environment=AETHEROPS_DB_PASSWORD=change-me   # 用环境变量或 config.json，永远不要用命令行参数
Environment=AETHEROPS_REDIS_HOST=127.0.0.1
Environment=HOST=127.0.0.1
Environment=PORT=9802
WorkingDirectory=/opt/aetherops
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=aetherops

[Install]
WantedBy=multi-user.target
```

进程在绑定端口时把 PID 写入 `~/.aetherops/aetherops.server.<port>.pid`，并在收到
`SIGINT`/`SIGTERM` 时删除它，所以用 supervisor 的停止信号就够了 —— 没有一个单独的关停命令。控制台输出
同时也会追加到 `~/.aetherops/server.log`。

**同一时间只能有一个实例。** 活跃的终端会话是进程内状态；一对负载均衡的实例会把某个浏览器的 HTTP 调用发给
一台、把它的 WebSocket 发给另一台，而「一个账号只有一个活跃会话」会在两个令牌写入者之间反复抖动。今天就
纵向扩容而言，这是唯一被支持的答案。

## 升级与回滚

```bash
# 1. 备份两半 —— 数据库*以及*密钥文件
mysqldump --single-transaction aetherops | gzip > aetherops-db.sql.gz
tar czf aetherops-data.tar.gz -C ~ .aetherops

# 2. 更新代码或镜像
git fetch --tags && git checkout v<新版本>      # 或者：docker pull / 重新构建
pnpm install --frozen-lockfile && pnpm run build-only

# 3. 重启：迁移会在端口绑定之前自动执行
pm2 restart aetherops-server
```

由 `schema_version` 的记录方式决定的几条规则：

- 待执行的迁移会在启动时自己应用；失败的迁移**不会**被记录，下次启动会重试，这就是为什么每一条语句都必须
  可重入。
- **迁移只进不退。** 把应用降级不会撤销已经应用的表结构变更。回滚一次升级意味着恢复第 1 步里的数据库
  dump —— 这同时也会丢掉那时之后写入的数据。
- 永远不要修改一个已应用的迁移；校验和检查存在的目的就是为了抓住这种情况。`--force` 是用来恢复一段被刻意
  重写过的历史，不是用来让报错消失的。
- 丢掉 `~/.aetherops/*.key`，等于所有存储的 SSH 口令、私钥和 AI API Key 都再也解不开。只有数据库 dump
  而没有它们，无法还原成一个可用的实例。

## 桌面端与 VS Code 打包

```bash
pnpm electron:build:win      # NSIS .exe
pnpm electron:build:mac      # DMG（x64 + arm64）
pnpm electron:build:linux    # AppImage / deb / rpm / snap
pnpm run vscode:package      # build-only → prepare-vscode-runtime → vsce package
```

产物落在 `release/`（桌面端）和 `packages/vscode/`（VSIX）。几点说明：

- CI 里的 macOS 构建是**临时签名**（ad-hoc signed，没有 Developer ID 证书），所以下载来的应用需要执行
  `xattr -cr /Applications/AetherOps.app` 才能过 Gatekeeper。
- VSIX 里打包了后端运行时（包括 `node_modules`），这正是 `scripts/prepare-vscode-runtime.mjs`
  成为必需步骤的原因；`AETHEROPS_VSCODE_PRUNE_PREBUILDS=1` 会把 node-pty 的预编译产物裁剪成当前平台，
  以便把压缩包减小一点。
- `scripts/electron-build.js` 为 Electron 和 electron-builder 的二进制设置了 npmmirror 端点。如果你在
  别处构建，请覆盖 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`。

## CI/CD 发版流程

两条 GitHub workflow，用 tag 前缀隔开，因此永远不会互相撞上：

| Workflow | 触发条件 | 产出 |
|----------|----------|------|
| `.github/workflows/build-vsix.yml` | tag `aetherops-v*` | 在同一个 GitHub Release 上产出 VSIX + win/mac/linux 桌面产物；随后发布到 VS Code Marketplace（`VSCODE_TOKEN`）和 Open VSX（`OVSX_TOKEN`）。在 `master` 推送和 PR 上也会跑，但只作为构建校验任务 |
| `.github/workflows/build.yml` | tag `v*`，或手动 dispatch 并选择平台 | 只产出桌面产物（备用渠道） |

还有第三条非 GitHub 的流水线：[`.cnb.yml`](../.cnb.yml) 跑在 CNB 构建平台（<https://cnb.cool>）上。
它在 `master` 推送时做构建校验，而在 tag 推送时只构建 **Linux** 的 Electron 产物，并把它们发布到一个
*CNB* 的 release（不是 GitHub Release）里，附带的下载说明会指回 GitHub。钉版规则与上面两条 workflow
相同：`npm i -g pnpm@10`、`pnpm install --frozen-lockfile`，以及同样的 npmmirror 端点。

细节：

- 每个任务都在 pnpm 10 / Node 22 上用 `pnpm install --frozen-lockfile` 安装（VSIX 相关的任务在工具链
  步骤上用 Node 20，因为它们不跑服务端）。
- 当 tag 与 `packages/vscode/package.json` 里的 version 不匹配时，`build-vsix.yml` 会拒绝发版 ——
  请先提升插件版本，再打 tag。
- 名字里含 `-` 的 tag（例如 `aetherops-v0.1.26-beta1`）会被标记为 `prerelease`。
- 发版任务需要 `contents: write`，workflow 里已经声明了；发布还需要把两个市场令牌配成仓库 secrets。

**这个仓库当前的状态：**还没有推送过任何 tag，因此 **Releases 是空的** —— 上面这些流水线描述的是「你打了
tag 之后会发生什么」，不是你今天就能下载的产物。在第一个 release 存在之前，请从源码安装或自己构建镜像。

```bash
git tag aetherops-v0.1.26
git push origin aetherops-v0.1.26
```

## 给 fork 的说明

如果你要发布自己的构建，这些是那些硬编码的改动点 —— 每一处都造成过「上游好好的，fork 就错」的反馈：

1. `electron/updater.js` —— `GITHUB_API` 指向 `repos/SubDong/AetherOps/releases/latest`。它只做
   *提示*有新版本（不会静默下载并替换），但一个 fork 会一直向它的用户播报上游的发版。
2. `packages/vscode/package.json` —— `publisher: "subdong"` 和 `name: "aetherops"` 决定了
   `vsce publish` 上传到哪里。用别人的 publisher ID 发布会在市场那一步失败，而不是在构建时失败。
3. 根 `package.json` —— `"name": "@subdong/aetherops"`、`"private": true`。除非你真的打算发布到 npm
   并且已经审过 `files` 字段，否则不要把 `private` 改掉。
4. `Dockerfile`、`.github/workflows/*` 和 `.cnb.yml` 里都是按区域选的镜像源 —— Debian/阿里云和
   npmmirror 端点都是为中国境内的构建调过的。如果你不用 CNB，请删掉 `.cnb.yml`；留着它意味着一次 tag 推送
   会在另一个平台上悄悄产出第二个、内容分叉的 release。
5. 保留许可证：[LICENSE](../LICENSE) 是 MIT，并带了对上游 AICmd 的署名；`packages/vscode/LICENSE`
   带着上游的声明。两份都要保留。
6. 改名的审计：标识符是从上游项目改名而来的（`AICMD_*` → `AETHEROPS_*`、`~/.aicmd` →
   `~/.aetherops`、`__AETHEROPS_SYS__`）。如果你再改一次名，请让
   `AETHEROPS_DATA_DIR`/`AETHEROPS_CONFIG` 的处理和旧数据迁移在两侧都保持一致。

## 运维安全

就算其他章节你都跳过，这一节也请读完。

- **AetherOps 交给 AI 的是一个真实的 shell。** 一句提示词就能在这个账号能抵达的每一台主机上执行命令。请把
  Web 端口当成一个 SSH 入口来对待，而不是当成一个 Dashboard：留在内网或放在 VPN 后面，在防火墙上限制它，
  并在前面加 TLS。
- **源码运行的默认绑定是 `127.0.0.1`**；只有容器镜像设置了 `HOST=0.0.0.0`。在一台有公网接口的机器上绑定
  `0.0.0.0` 是一次刻意的暴露。
- **认证无法被关闭。** 旧的 `auth.disabled` / `auth.accessToken` 开关已经移除；配置里如果还残留它们，会
   被告警并丢弃。本地开发同样使用真实账号。
- **授予能干活的最小权限位集合。** 自助注册的账号初始是 `pending` 且什么都没有；`batch`（一条命令打向 N 台
  主机）之所以从 `terminal` 里拆出来，正是这个原因。注册这件事**在应用里关不掉** —— 如果实例的可达范围超出
  你的网络，请在代理上封掉 `/api/auth/register`。见
  [accounts-and-permissions.zh.md](./accounts-and-permissions.zh.md#注册与授权)。
- **分别保护秘密的两半。** MySQL 里放着加密后的凭据；`~/.aetherops/*.key` 里放着解密它们的能力。同时拿到
  两者的人就能读出所有存储的 SSH 凭据。
- **审计是数据，不是安全控制。** 命令与传输历史按账号记录在 MySQL 里；它自己不会阻断任何东西，而且删除账号
  会连带清除该归属下的所有行 —— 必须先导出的内容，请在移除任何人之前导出。
- **没有内置的限流与暴力破解防护。** 登录既没有锁定也没有按 IP 节流；请把这一层做在反向代理上。
- 出站请求仅限于你配置的 AI 服务商、可选的 OpenRouter 价格目录，以及（仅桌面端）GitHub 的 releases 接口。
  除此之外不向任何地方发送数据；见 [README § 对外网络请求与隐私](../README.zh.md#对外网络请求与隐私)。
