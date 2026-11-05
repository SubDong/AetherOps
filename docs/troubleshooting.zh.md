# 故障排查

[English](./troubleshooting.md) · **简体中文**

按你最先看到的症状组织。每条都说明这个失败**到底意味着什么**，好让你判断该改的是自己的配置、代理，还是代码。

- [服务起不来](#服务起不来)
- [登录与授权](#登录与授权)
- [终端会话问题](#终端会话问题)
- [文件传输与 zmodem](#文件传输与-zmodem)
- [AI 功能](#ai-功能)
- [服务器状态面板](#服务器状态面板)
- [数据库与迁移](#数据库与迁移)
- [构建与安装](#构建与安装)
- [桌面端与 VS Code 宿主](#桌面端与-vs-code-宿主)
- [提 issue 该带什么](#提-issue-该带什么)

## 服务起不来

启动顺序是刻意排的，目的让坏依赖在**绑端口之前**就中止：加载配置 → 校验 → 探活 MySQL 并执行待跑迁移 →
探活 Redis → 初始化服务（含初始管理员）→ `listen()`。不存在「界面能打开、但每个查询都报错」这种半可用状态。

| 日志行 | 含义 | 处理 |
|--------|------|------|
| `[FATAL] 配置加载失败: …` | `config.json` 不是合法 JSON，或 `AETHEROPS_CONFIG` 指向了不存在的文件 | 修好文件。显式指定的路径不存在即为致命，这是刻意的，见 [configuration.zh.md](./configuration.zh.md#配置放在哪里) |
| `[FATAL] 数据库配置不完整: …` 后面跟着 `请编辑 …（或用 AETHEROPS_DB_* 环境变量提供）` | `database.host` / `database.user` / `database.database` / `database.password` / `redis.host`（或 `redis.keyPrefix`）为空，或端口/连接池取值越界 | 填好 `database` + `redis` 两段，或导出 `AETHEROPS_DB_*` / `AETHEROPS_REDIS_*`。问题清单是**一次性全部**打印的，所以那一行里列的每一项都要修，不是只修第一个 |
| `[FATAL] 依赖服务不可用（MySQL / Redis），服务不启动` | 配置校验过了，但探活失败（主机/端口不对、拒绝访问、不可达、Redis 要求认证） | 看它正上方打印的具体原因；并从应用运行的**同一台**机器上测连通性 |
| `[ERROR] 找不到 server 构建产物: …/dist/server/index.js` | 还没构建就跑 `node server.js` | `pnpm run build-only`（开发态源码不能被服务端直接执行） |
| `ssl: true` 时 TLS 握手报错 | Ubuntu 的 MySQL 自带自签证书 | 要么配 `sslCaPath` 并把 `sslRejectUnauthorized` 设成 `true`，要么保持 `false`（仍加密，但不抗中间人）。部分组合按设计就是直接启动失败 |

**MySQL 密码为空会被当作「未配置」**并中止启动；`AETHEROPS_DB_PASSWORD=`（空值）也覆盖不掉，因为空白环境变量值
会被忽略。这是一个有意识的选择 —— 错误的凭据应该在启动时以一句可读的报错失败，而不是晚一点以数据层错误的形式
冒出来 —— 但代价是：本地那个免密的 `root` 账号用不了。请建一个带密码（任意值）的具名 MySQL 账号来用。

同一端口上的第二个实例会以 `EADDRINUSE` 失败。PID 文件 `~/.aetherops/aetherops.server.<port>.pid` 在成功绑端口
之后写入，在 `SIGINT`/`SIGTERM` 时清理；崩溃后残留的文件**不会**挡住下一次启动。

如果终端日志里出现了你没设过的配置键，去找 `deprecated` 警告：`auth.disabled` 与 `auth.accessToken` 会被读取、
丢弃并报告 —— 它们属于已移除的单令牌方案，认证没有任何关闭方式。

## 登录与授权

| 症状 | 原因 | 处理 |
|------|------|------|
| 每个请求都 `403 Forbidden origin`，或登录页一直转圈 | `Origin` 头里的 host 既不等于 `Host` 头，也不是 localhost | 反向代理必须转发原始 host：`proxy_set_header Host $host;`。WebSocket 握手同理 |
| 刚登录成功就 `401 Unauthorized` | 令牌过期（7200 秒滑动），或者你在别处登录了 —— **一个账号只有一个活跃会话** | 重新登录。如果确实需要第二个浏览器/标签页同时在线，那是设计约束，不是 bug |
| 前端提示会话被顶替 | 同一账号拿到了新令牌（换了设备，或管理员重置过） | 预期行为；`session_replaced` 与普通过期是刻意区分的 |
| 登录进去了，但每个面板都提示无权限 | 自助注册出来的是 `status=pending` 且 **10 个权限位全关** | 由管理员在 **账号菜单 → 用户管理** 授予权限位 |
| 「不能降权 / 停用 / 删除」（HTTP 409） | 最后一个可用管理员受保护；且自改时不能动自己的 `role`/`status` | 用第二个管理员账号操作。这道保护是为了防止不可恢复的自锁 |
| 密码明明正确却被拒 | 账号由管理员创建，生成的密码只在当时展示过一次 | 让管理员重置（会生成新密码） |
| 恢复数据目录之后完全登不进去 | `users` 在 MySQL，令牌在 Redis —— 只恢复一半不算恢复 | 两半都恢复；没有离线重置口令的命令，所以务必留一个你随时能触达的管理员账号 |

登录失败被刻意做成不可区分（「账号不存在」和「密码错误」耗时接近、返回同一句提示），所以客户端这边没什么可诊断的。
服务端也没有按账号的锁定机制 —— 速率限制是反向代理的职责。

## 终端会话问题

**连上了但一直卡在「连接中…」** —— WebSocket 开起来了，会话却从未创建。按顺序检查：代理是否转发了
`Upgrade`/`Connection` 头（见 [deployment.zh.md](./deployment.zh.md#反向代理与-tls)）；账号是否有 `terminal`
权限（握手在那之前就会以 `1008` 关闭，没有它根本建不了会话）；`?token=` 里的令牌是否仍有效。

**套接字立刻以 `1008` 关闭** —— 来源被拒、令牌无效，或缺 `terminal` 权限。关闭原因分别是
`Forbidden origin` / `Unauthorized` / `Forbidden`，所以 reason 字符串会直接告诉你是三条里的哪一条触发了。

**高输出时画面滞后或丢字符** —— 当套接字发送缓冲超过 4 MB 时，高频帧会被丢弃（日志里是
`[WS] Backpressure: dropping message`）。这是刻意的降级：丢一屏好过把 shell 卡住。**远端** shell 自己的回滚缓冲
不受影响，丢的只是你浏览器没收到的那部分。典型触发器是 `cat` 一个大二进制文件。

**命令跑在了错误的主机上** —— 几乎总是界面上的会话 id 串了，而不是后端错了。每条带 `sessionId` 的消息在服务端
都会做归属校验；如果你能看见别人账号的会话 id，应当拿到一个拒绝 —— 真是那样的话是值得上报的 bug。

**SSH 认证失败且没有有用信息** —— 打开 `debug.sshDebug`（或 `AETHEROPS_SSH_DEBUG=1`），ssh2 的协议跟踪会被转发到
前端终端里。同时确认存下来的凭据：私钥是用 `~/.aetherops/connections.key` 解密的，所以只恢复了数据库、没带回那个
文件的话，认证失败看起来会像「密码错了」。

**跳板机会话停在跳板机上不动** —— 启动脚本是在通道打开约 800 ms 后写进 shell 的。如果 MOTD 很长或链路很慢，
在脚本前面加一行 `sleep 1`（见 [jump-host.zh.md](./jump-host.zh.md)）。

## 文件传输与 zmodem

- **上传被 413 拒 / "File too large"** —— `auth.maxUploadMb`（默认 100）限制 HTTP 上传大小，并据此决定 WebSocket
  的 `maxPayload`（上限 × 1.4，因为 base64 会膨胀约 33%）。改配置或用 `AETHEROPS_MAX_UPLOAD_MB` 调大，同时检查
  代理自己的 `client_max_body_size`。
- **`rz` / `sz` 卡住、文件损坏、或时好时坏** —— 随包附带的 `patches/zmodem.js.patch` 就是让 zmodem 流程可靠的
  关键。如果补丁没生效（锁文件里缺 `patchedDependencies`），构建会在钉版校验这一步失败；而手工拼出来的
  `node_modules` 缺补丁时是**静默**降级。用 `pnpm run check-pin` 确认。
- **文件落到了错误的目录** —— Web 界面在上传前会查询当前工作目录。当远端 `rz` 正在等待时，这次探测会被跳过
  （注入文本会打断它），所以目标目录可能是旧的。`rz` 结束后重跑一次传输，或者改用文件管理器。
- **下载得到 0 字节文件** —— 检查目标 sshd 是否启用了 SFTP 子系统；终端通道能用，不代表 SFTP 也能用。

## AI 功能

| 症状 | 解释 |
|------|------|
| 模型列表为空 / 对话拒绝开始 | 这个账号没有服务商配置。AI 设置按账号隔离；第二个账号进来时是空的 |
| `chat-token-limit` / `daily-token-limit` / `daily-cost-limit` | 撞到了预算上限；错误里带具体数字（例如 `(182340/200000)`）。`0` 表示不限 —— 如果你只是想「清零」，把该字段设成 `0` |
| 成本显示为*未知* | 保存该配置时定价目录不可达。成本从不猜测：价格未知就显示未知，而不是 `$0` |
| 当日成本看起来偏低，且面板标了 partial | 部分调用没有已知价格；请把当日合计当作下限 |
| `auto` 永远选同一个模型 | 你的所有配置都停在默认档位 3（既无价格也不匹配名称规则），于是它们与任何目标档位的距离都一样。手工设 `cost_tier`，或让目录给它们定价 |
| AI 请求被代理拦掉 | 出站只有两件事：你的服务商，以及 OpenRouter 目录（`https://openrouter.ai/api/v1/models`，无需 key）。第二个是尽力而为、8 秒超时、静默降级 —— 允许被封禁 |
| 回答流到一半停了 | 服务商侧超时，或反向代理的缓冲设置。给 API 路径关掉响应缓冲（`proxy_buffering off;`），别让 SSE/WS 帧被攒着 |

## 服务器状态面板

面板探测的是**远端**主机，并按其 OS 家族自适应（`windows` / `macos` / `linux` / `harmony` / `unix` /
`unknown`）。你看到的东西受限于该平台暴露了什么：

- 采不到的指标会被标成*不支持*，渲染成「无法采集 / not collectable」并且**不画曲线**，而不是在 0 上画一条平线。
  少一张图是关于该平台的陈述，不是 bug。
- 跳板机会话的面板描述的是**跳板机**，因为探测就跑在那里。AI 仍可能通过启动脚本瞄准最终主机，但状态面板不会跟着
  跳转走。
- 鸿蒙识别是基于特征的（`/etc/os-release`、`OHOS_*`、`hongmeng` 标记），特征模糊时回落到 Linux。如果某台鸿蒙机器
  报成了 Linux，那是一处识别缺口，值得带着 `uname -a` 与 `/etc/os-release` 的原始输出来上报。

## 数据库与迁移

- **迁移没执行并且服务退出了** —— 迁移跑在 `listen()` 之前；日志会点出版本号和 SQL 错误。失败的迁移**不会**被
  登记，所以下次启动会重跑它。这就是为什么 `server/db/migrations/` 里每条 `ALTER` 都包在 `information_schema`
  检查里。
- **`checksum` 不一致** —— 你改了一个已经应用过的迁移。不要用 `--force` 把它压掉；要么回滚文件，要么写一个新迁移。
  手改已应用的迁移会让生产环境的表结构不可复现。
- **想先看再执行** —— `node scripts/migrate.mjs --status`（已应用版本 + 待执行数量）、`--dump 0002`（导出成纯 SQL）。
- **严格模式下的 duplicate entry / 数据类型错误** —— 表结构面向 `STRICT_TRANS_TABLES`/`NO_ZERO_DATE`，时间列是
  `DATETIME(3) NOT NULL` 且不带数据库侧默认值，时间戳由应用以 UTC 的 `Date` 提供。外部工具若用 `NOW()` 往一台
  `system_time_zone` 不是 UTC 的服务器上写行，值就会整体漂移（参考实例跑的是 `CST`，因此驱动时区定为 `+00:00`）。
- **出现谁也读不到的行** —— `owner_id` 刻意没有默认值；你加表时请保持这条规则，让漏传归属大声失败，而不是静默写入
  `''`。

## 构建与安装

| 报错 | 原因 | 处理 |
|------|------|------|
| `[pin] … 声明成了范围「^1.0.0」` / `声明 1.0.80，实际装的是 …` | 钉版校验拒绝版本范围，也拒绝与 `package.json` 不一致的 `node_modules` | `pnpm install --frozen-lockfile`；要升级就走 `pnpm run upgrade-pin -- <pkg>@<ver>`，并把 `package.json` + 锁文件一起提交 |
| `[pin] pnpm-lock.yaml 是 pnpm 11/12 写的 …` | 较新的 pnpm 把锁重写成了 CI 的 pnpm 10 在 `--frozen-lockfile` 下拒绝的形状（`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`） | 用 CI 的大版本重新生成：`npx pnpm@10 install --lockfile-only` |
| CI 里 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` | 同上根因，只是暴露得更晚 | 同上；本仓库刻意没有 `packageManager` 字段去强制重建你本地的 `node_modules` |
| 原生模块编译失败（`node-pty`、`ssh2`、`cpu-features`） | 缺 C++ 工具链 | Linux `python3 make g++`；macOS Xcode CLT；Windows VS Build Tools（C++ 负载） |
| 安装后脚本被跳过、终端坏了 | pnpm 只跑被允许清单里的依赖构建脚本 | 清单在 `pnpm-workspace.yaml` —— `onlyBuiltDependencies`（pnpm 10/11）与 `allowBuilds`（pnpm 12+），两份是刻意同时保留的 —— `package.json#pnpm` 里有一份更短的镜像。`pnpm approve-builds` 可交互式追加。如果 `node-pty`/`ssh2`/`cpu-features` 被跳过了，删掉 `node_modules` 并在清单就位后重装 |
| `EBADENGINE` 警告，或 agent-core 运行时抛语法错误 | Node 低于钉住引擎的要求（`>= 22.17.0`） | 用 Node 22 LTS 或更新；Docker 与 CI 都是 22 |
| 解析 `@cicctencent/agent-core` 时安装失败 | 它被钉死版本、从公共 npm registry 拉取 —— 会过滤包的镜像或防火墙会掐断它 | 为该 scope 放行 `registry.npmjs.org`（或等价的 npmmirror） |
| "build complete" 之后构建卡住 | `vite build` 在某些环境里会因为 watcher 让进程多活一会儿 | `dist/` 写完之后再 Ctrl-C 是安全的；必须完成的是服务端构建（`tsc -p tsconfig.server.json`） |

## 桌面端与 VS Code 宿主

- **macOS：「应用已损坏」/ Gatekeeper 拦下** —— CI 产物是 ad-hoc 签名（没有 Developer ID 证书），所以需要清除隔离
  属性：`xattr -cr /Applications/AetherOps.app`。
- **自动更新发现了新版本但没装上** —— 桌面端只做*提示*，不会静默下载并替换二进制。
- **fork 收不到更新 / 更新指向了别人的项目** —— `electron/updater.js` 查的是硬编码的 `SubDong/AetherOps` GitHub
  Releases 端点。自己发布构建的话要改它。
- **VS Code 宿主：报「server did not become ready」但端口确有响应** —— 宿主注入 `AETHEROPS_LAUNCH_TOKEN` 时
  `/health` 会校验该令牌，所以恰好占住端口的无关进程无法冒充我们的服务。腾出端口（默认 9802）或换一个。
- **VS Code 宿主在你机器上正常、别人那里坏** —— 扩展用它自己解析出的 Node 可执行文件（`AETHEROPS_NODE`）拉起后端。
  如果那个 Node 低于引擎要求，服务端在 import 阶段就死了；看扩展的输出面板。
- **VS Code 里终端面板空白** —— webview 页面（`vscode-term`、`vscode-edit`）是打进 VSIX 的构建产物。没有跑
  `node scripts/prepare-vscode-runtime.mjs` 就打出的 VSIX 缺少后端运行时；请用 `pnpm run vscode:package`。
- **VS Code 侧边栏显示「服务未启动」并带 `HTTP 401`，而后端其实健康** —— 扩展宿主自己的 `getConnections()` /
  `deleteConnection()` 调用不带 Bearer 令牌（已记录的缺口，见
  [packages/vscode/README.md](../packages/vscode/README.md)）。请在 WebView 里登录并在那边管理连接；这棵树的可靠性
  目前不能当健康检查用。
- **VS Code：「server did not become ready」并且端口一直没开** —— 扩展启动的是同一套生产后端，若
  `~/.aetherops/config.json` 的 `database`/`redis` 段是空的，它会以 `[FATAL] 数据库配置不完整` 退出。子进程继承 VS Code
  自身的环境（去掉 `NODE_OPTIONS`，因为宿主注入的它会让干净的 Node 启动失败），所以 `AETHEROPS_DB_*` 只有 VS Code
  进程本身带着时才看得到 —— 从桌面图标启动通常不带。请把配置写进配置文件，或者从一个已导出这些变量的 shell 里
  启动 VS Code。真正的原因在 Output 面板 → `[aetherops-server]` 那些行里。

## 提 issue 该带什么

按下面的顺序提供 —— 通常还没等人回复，问题就已经被回答了：

1. 宿主（web / Electron / VS Code）、版本（`package.json` 里的版本或 release 标签）、运行 AetherOps 的机器 OS，
   如果涉及远端主机还要给出**目标机** OS。
2. Node、pnpm、MySQL/Redis 版本；MySQL 是否启用了 TLS。
3. `~/.aetherops/server.log` 里相关的那一段（与控制台是同一份文本），前端问题再附浏览器 DevTools 控制台。
4. 精确的 `[FATAL]` / `[pin]` / `[WS]` / 迁移日志行 —— 它们写出来就是要大声失败的，所以原文引用比描述症状更快。
5. 复现步骤，并带上你使用的那个账号的权限位，因为大多数「为什么被拒」的回报其实是 pending 账号或权限被收回。

**发帖前先脱敏。** `server.log` 里可能有主机名、用户名、连接名、命令文本与终端输出。请去掉秘密和内网地址；
不要附上你没读过的日志。安全问题请走 [SECURITY.md](../SECURITY.md)，不要开公开 issue。
