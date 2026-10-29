# 部署指南

## 部署方式概览

| 方式 | 适用场景 | 复杂度 |
|------|---------|--------|
| **npm 全局安装** | 个人使用、快速体验 | ★☆☆ |
| **Docker** | 服务器部署、团队共享 | ★★☆ |
| **源码构建** | 开发、定制 | ★★☆ |
| **Electron 桌面应用** | 桌面端用户 | ★☆☆ |
| **GitHub Actions CI/CD** | 自动化发布 | ★★☆ |

## 1. npm 全局安装

> 本仓库是私有 fork（根 `package.json` 中 `"private": true`），**尚未发布到 npm**。
> 下面的命令仅在把 `private` 改回 `false` 并发布后可用；日常部署请用第 2、3 节的方式。

```bash
# 安装
npm install -g @subdong/aetherops

# 启动（默认端口 9802，自动寻找可用端口）
aetherops start

# 自定义端口
aetherops start --port 3000

# 管理
aetherops stop       # 停止
aetherops restart    # 重启
aetherops -v         # 查看版本
```

启动后在浏览器中打开 `http://localhost:9802`。

### 环境要求

- Node.js >= 18
- 原生模块（node-pty、ssh2）需要编译工具：
  - **Linux**: `apt-get install python3 make g++`
  - **macOS**: `xcode-select --install`
  - **Windows**: `npm install --global windows-build-tools`

## 2. Docker 部署

### 快速启动

```bash
# 构建镜像
docker build -t aetherops .

# 运行容器
docker run -d \
  --name aetherops \
  -p 9802:9802 \
  -v ~/.aetherops:/root/.aetherops \
  aetherops
```

> 镜像已声明 `VOLUME /root/.aetherops`，所以忘写 `-v` 时数据会落到自动创建的匿名卷里，
> 不会随容器重建消失；但匿名卷不好备份，生产环境仍建议像上面那样显式绑定目录。
> 若设了 `AETHEROPS_DATA_DIR`，挂载路径要跟着改。

### Docker Compose

```yaml
version: '3.8'
services:
  aetherops:
    build: .
    ports:
      - "9802:9802"
    volumes:
      - aetherops-data:/root/.aetherops
    restart: unless-stopped

volumes:
  aetherops-data:
```

```bash
docker-compose up -d
```

### Dockerfile 说明

项目使用多阶段构建：

1. **构建阶段**：基于 `node:22-slim`，换阿里云 Debian 源，安装编译工具（python3 / make / g++）+ pnpm 9，执行 `pnpm install` 和 `pnpm run build`
2. **生产阶段**：基于 `node:22-slim`，只拷 `dist`、`node_modules`、`server.js`、`bin`、`public`、`data/skills` 等运行所需文件

数据持久化在 `/root/.aetherops`（即容器内的 `~/.aetherops`），通过 volume 挂载保留；
`data/skills` 是内置技能目录，服务端按 `process.cwd()/data/skills` 读取，与数据目录无关。
镜像内置 `HOST=0.0.0.0`、`TZ=Asia/Shanghai`、`NODE_ENV=production`。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口（`--port` / `-p` 参数优先级更高） | `9802` |
| `HOST` / `AETHEROPS_HOST` | 监听地址；`HOST` 优先，两者都未设则只绑本机 | `127.0.0.1` |
| `AETHEROPS_DATA_DIR` | 自定义数据存储目录；设置后**不会**执行 `~/.aicmd` 旧目录自动迁移 | `~/.aetherops` |
| `AETHEROPS_CONFIG` | 直接指定配置文件路径（绝对路径，或相对当前工作目录）。设置后**不再**读写数据目录下的 `config.json`，也不会在那边生成模板；指错路径会直接报错退出 | 未设 |
| `AETHEROPS_DB_HOST` / `AETHEROPS_DB_PORT` / `AETHEROPS_DB_USER` / `AETHEROPS_DB_PASSWORD` / `AETHEROPS_DB_NAME` | 覆盖 `config.json` 里 `database` 段的对应项，用于不想把密码落盘的场景 | 主机/账号/密码为空，库名 `aetherops` |
| `AETHEROPS_DB_POOL_SIZE` / `AETHEROPS_DB_SSL` / `AETHEROPS_DB_TZ` | 连接池上限 / 是否走 TLS / 驱动时区 | `10` / 未设 / `+00:00` |
| `AETHEROPS_ACCESS_TOKEN` | 固定访问令牌；未设置则每次启动随机生成并打印到日志 | 随机生成 |
| `AETHEROPS_AUTH_DISABLED` | 设为 `1` / `true` 关闭令牌校验。仅适用于内网临时调试，对外暴露等于无认证 | 未设 |
| `AETHEROPS_MAX_UPLOAD_MB` | 单次文件上传上限（同时决定 WS `maxPayload`） | `100` |
| `AETHEROPS_SSH_DEBUG` | 设为 `1` 时转发远端 `ssh -vvv` 调试输出到前端，便于排障 | 未设 |
| `AETHEROPS_NODE` | 指定启动后端的 `node` 可执行文件路径（VSCode 扩展宿主使用） | 自动探测 |
| `AETHEROPS_LAUNCH_TOKEN` | `/health` 探活令牌，由 VSCode 扩展注入，避免端口被无关进程占用时误判就绪 | 未设 |
| `AETHEROPS_BUNDLED` | 打包态标记，由 `scripts/prepare-vscode-runtime.mjs` 在构建时注入，**不要手工设置** | 未设 |
| `AETHEROPS_VSCODE_PRUNE_PREBUILDS` | 设为 `1` 时把 node-pty 预编译产物裁剪到当前平台以节省体积 | 未设 |

AI 服务商配置（provider / baseURL / model / apiKey）**只能通过界面内的 AI 设置填写**，
服务端把它存在 `~/.aetherops/ai-config.json`，其中 apiKey 以 AES-256-GCM 加密（`enc:v1:` 前缀 + 同目录 `ai-config.key`）。
注：代码里并没有读取 `OPENAI_API_KEY` 环境变量；`API_URL` 仅在 `pnpm dev` 下由 vite 注入前端的
`config.apiUrl`（后端 API 的基地址，不是 AI 服务地址），生产环境留空即自动按 `location` 推导。

## 3. 源码构建

```bash
# 克隆
git clone https://github.com/SubDong/AetherOps.git
cd AetherOps

# 安装依赖
pnpm install

# 开发模式（热重载，端口 9801）
pnpm dev

# 生产构建
pnpm build          # 前端 + 服务端 TypeScript 编译
pnpm build-server   # 仅服务端

# 启动生产模式
node server.js --port 3000
```

## 4. Electron 桌面应用

### 从源码构建

```bash
# 开发模式（热重载）
pnpm electron:dev

# 构建安装包
pnpm electron:build          # 当前平台
pnpm electron:build:win      # Windows → NSIS 安装包 (.exe)
pnpm electron:build:mac      # macOS → DMG (x64 + arm64)
pnpm electron:build:linux    # Linux → AppImage
```

构建产物在 `release/` 目录。

### 构建要求

| 平台 | 要求 |
|------|------|
| Windows | Visual Studio Build Tools（C++ 工作负载） |
| macOS | Xcode Command Line Tools |
| Linux | `python3`, `make`, `g++`, `rpm`, `fakeroot` |

原生模块（`node-pty`, `ssh2`, `cpu-features`）需要 C++ 编译工具来为 Electron 重新编译。

### 镜像加速（中国用户）

构建脚本已内置 npmmirror 镜像：

```javascript
// scripts/electron-build.js
process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
```

如需自定义镜像，在构建前设置环境变量：

```bash
export ELECTRON_MIRROR=https://your-mirror.com/electron/
pnpm electron:build
```

## 5. GitHub Actions CI/CD

项目配置了 GitHub Actions 自动化构建工作流（`.github/workflows/build.yml`）。

### 触发方式

**自动触发**（推送版本标签）：

```bash
git tag v0.1.6
git push origin v0.1.6
```

**手动触发**：在 GitHub 仓库 → Actions → Build & Release → Run workflow，可选择构建平台。

### 构建矩阵

| Job | Runner | 产物 |
|-----|--------|------|
| `build-windows` | `windows-latest` | `.exe` (NSIS) |
| `build-macos` | `macos-latest` | `.dmg` (x64 + arm64) |
| `build-linux` | `ubuntu-latest` | `.AppImage` |

### 构建流程

每个平台的 Job 执行以下步骤：

1. Checkout 代码
2. Setup Node.js 20 + pnpm
3. 安装系统依赖（Linux: rpm, fakeroot）
4. `pnpm install` 安装项目依赖
5. `node scripts/electron-build.js --platform=<platform>` 构建
6. 上传安装包到 GitHub Release

### CI 与本地构建的差异

| 特性 | CI | 本地 |
|------|-----|------|
| `npmRebuild` | `true`（Runner 有编译工具） | `false`（避免无工具时报错） |
| 原生模块 | 全部 rebuild for Electron | 使用 pnpm 预编译的二进制 |
| 镜像源 | 内置 npmmirror | 内置 npmmirror |

### 发布流程

1. 更新 `package.json` 中的 `version`
2. 创建并推送版本标签：
   ```bash
   npm version patch  # 或 minor / major
   git push origin master --tags
   ```
3. GitHub Actions 自动构建并创建 Release
4. 在 Release 页面填写更新说明

## 数据存储

所有数据存储在本地，不依赖外部数据库：

```
~/.aetherops/
├── config.json         # 配置文件（首次启动自动生成，权限 0600）
├── connections.json    # SSH 连接配置
├── connections.key     # 上述敏感字段的加密密钥
├── sessions.json       # 终端会话状态
├── ai-config.json      # AI 配置（API Key、模型等）
├── ai-config.key       # AI 配置的加密密钥
├── ai-history/         # 聊天历史
├── audit/              # 审计日志（按日分文件）
│   └── 2025-06-01.jsonl
├── skills/             # 用户自定义技能
│   └── my-deploy.md
├── access-token        # 未固定令牌时的随机访问令牌
├── server.log          # 服务端日志
└── .trash/             # 回收站
```

使用 `AETHEROPS_DATA_DIR` 环境变量可覆盖默认路径：

```bash
AETHEROPS_DATA_DIR=/data/aetherops node server.js
```

## 配置文件

`~/.aetherops/config.json` 是本项目唯一的配置文件，首次启动时自动生成模板，分四段：

| 段 | 作用 |
|------|------|
| `server` | 监听端口与地址（对应 `PORT` / `HOST`） |
| `database` | MySQL 连接参数（主机/端口/账号密码/库名/连接池），待存储层接入后生效 |
| `auth` | 令牌开关、上传上限 |
| `debug` | SSH 调试输出转发 |

优先级：内置默认值 < 配置文件 < 环境变量。因此同一份镜像可以用环境变量临时改行为，
不必动盘上的文件；把密码写在配置文件里则重启后仍然有效。

环境变量命名见上文 `AETHEROPS_DB_*` / `AETHEROPS_ACCESS_TOKEN` 等条目。文件内容写坏（不是
合法 JSON）会直接报错退出，不会静默回到默认值；`database` 段填写完成后，日志会打印
一行 `user@host:port/dbname` 的连接摘要（不含密码）以便确认到底读到了哪份配置。

## 反向代理

### Nginx

```nginx
server {
    listen 80;
    server_name aetherops.example.com;

    location / {
        proxy_pass http://127.0.0.1:9802;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

**注意**：必须配置 WebSocket 升级（`Upgrade` + `Connection` 头），否则终端和 AI 实时通信无法工作。

## 安全建议

1. **不要暴露到公网**：AetherOps 提供完整的终端访问能力，应仅在内网或通过 VPN 访问
2. **配置防火墙**：仅允许信任的 IP 访问 9802 端口
3. **使用反向代理 + HTTPS**：通过 Nginx/Caddy 配置 TLS 加密
4. **定期更新**：关注安全更新，及时升级版本
