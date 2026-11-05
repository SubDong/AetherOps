# 技能：给 Agent 复用的操作手册

[English](./skills-guide.md) · **简体中文**

一个技能就是一份 Markdown 操作手册，它会在**这一次运行**里被注入 Agent 的系统提示词。它告诉模型在你这套
基础设施上*怎么*做某一类任务 —— 步骤、平台差异、安全检查、输出格式 —— 而不是让它每次都临场发挥。

```markdown
---
name: Docker Management
description: Docker container lifecycle management, cleanup, monitoring, and troubleshooting
tags: [ops, docker, containers]
---

Manage Docker containers, images, volumes, and networks efficiently. Use scripts for batch operations.
...
```

- [技能从哪儿来](#技能从哪儿来)
- [写入路径目前的上限](#写入路径目前的上限)
- [文件格式](#文件格式)
- [技能是如何被选中的](#技能是如何被选中的)
- [Agent 实际收到了什么](#agent-实际收到了什么)
- [内置技能](#内置技能)
- [怎么写好技能](#怎么写好技能)
- [完整示例](#完整示例)
- [调试](#调试)
- [贡献技能](#贡献技能)

## 技能从哪儿来

| 来源 | 位置 | 作用范围 | 加载方式 |
|------|------|----------|----------|
| **内置** | `<应用根目录>/data/skills/*.md` | 所有人，只读 | 进程启动时读一次，取自 `process.cwd()/data/skills` |
| **用户** | MySQL 表 `skills`，以 `owner_id` 为键 | 单个账号 | 每次列表/读取都查库 —— 进程内从不缓存 |

内置是跟着代码一起走、跟着 git 一起动的文件，所以可被评审。用户技能是数据库行，因为一个共享的 Web 实例不可能
把同一个目录的写权限发给每个账号。

合并规则：在某个账号的视角里，用户技能会**替换**掉同 id 的内置技能（id 就是去掉 `.md` 的文件名；对数据库行来说
就是那行的键）。两个账号互相看不到彼此的用户技能 —— 服务刻意不缓存合并后的大表，因为一个进程服务所有人。

注意 `data/skills` **不在**数据目录（`~/.aetherops`）下：Docker 镜像专门把它 `COPY` 到 `/app/data/skills`，
原因就是这个查找路径是相对工作目录的。容器里漏掉这一步，技能列表就是空的。

## 写入路径目前的上限

这里明说，因为上游的文档承诺得比代码能做的更多：

- `SkillService.saveUserSkill()` 与 `deleteUserSkill()` 存在且可用，`skills` 表也准备好了，但**没有任何 HTTP
  接口、也没有任何界面调用它们**。注册在册的路由只有 `/api/ai/getSkills` 和 `/api/ai/getSkill`。
- 因此今天的实际情形是：写一个技能等于在 `data/skills` 里改文件，这需要对后端所在机器的文件系统访问权，还要
  重启。在共享部署上，这是运维动作，不是用户功能。
- 也没有热重载接口。新增或修改内置文件是在下一次重启后生效（`skillService.reload()` 没有挂到任何路由上）。

如果你想要按账号创建技能，这是一个合理的贡献方向：加上按归属隔离的路由，把它们放在 `skills` 权限位之后，并复用
现有的仓储函数，而不是另起一套存储路径。

## 文件格式

技能文件是「类 YAML 的 front matter + Markdown」。解析器是一段手写的正则
（`skill.service.ts#parseSkillFile`），不是 YAML 库，所以支持的形状很窄：

```markdown
---
name: Nginx Management
description: Manage Nginx - config validation, reload, SSL, troubleshooting
tags: [ops, nginx, web, ssl]
---

正文：给 Agent 的具体指令写在这里
```

| 字段 | 必填 | 作用 |
|------|------|------|
| `name` | 否（缺失时回退为文件 id） | 显示在技能面板里，也出现在注入的段落标题里 |
| `description` | 否 | 显示在面板里；当你只发一个光秃秃的 `/skill-id` 时，它被当作任务文本 |
| `tags` | 否 | 仅元数据，在列表里带出来。**没有任何东西按 tags 自动匹配** |
| 正文 | 实践上必须 | Agent 要照着执行的那些指令 |

实际会咬人的解析器约束：

- front matter 必须从文件的**第 0 个字节**以 `---` 开始；任何别的情形（首行是空行、分隔符前有 BOM）都会被当成
  「没有 front matter」，于是整个文件 —— 连分隔符一起 —— 变成正文。
- 每个字段必须是**一行**，匹配 `^key:\s*value`。多行 YAML 块、嵌套映射、块状列表（`- item`）、注释统统不被理解；
  值会被原样取到行尾。
- 值里出现的引号和方括号都会被剥掉，所以 `tags: ["ops", "nginx"]` 和 `tags: ops, nginx` 都能用；而
  `description: "He said "hi""` 这种就别指望它聪明。
- 只读 `name`、`description`、`tags` 三个键。多余的键（`version`、`author`、`platform`）会被忽略 —— 留给人看没问题，
  加载器看不见。
- 读不出来的文件会打日志（`[SkillService] Failed to parse skill: …`）然后跳过，不会阻止启动，所以一个拼写错误
  可能静默地让某个技能从列表里消失。
- 编码：UTF-8。CRLF 与 LF 都能解析（正则接受 `\r?\n`）。
- id 就是文件名：`nginx-management.md` → `/nginx-management`。文件名里有空格或非 ASCII 会让斜杠命令很难用 ——
  请用 kebab-case。

代码里没有强制的大小限制。正文会在一次运行的每一轮里原样注入，所以一份 50 KB 的手册就是从你的上下文窗口里
拿走 50 KB；内置技能刻意都控制在几 KB 以内。

## 技能是如何被选中的

两条路径，都需要人明确指定 —— Agent 从不自己挑技能：

1. **技能面板** —— 在对话区打开它并点选一个技能；它会保持选中（带一个清除按钮）直到你发送，然后复位。
2. **斜杠命令** —— 输入 `/` + 技能 id。匹配是对 id 做精确、忽略大小写的比较，且只在消息以 `/` 开头时发生：

   | 你输入 | Agent 收到什么 |
   |--------|----------------|
   | `/docker-manage` | 该技能的指令，任务文本用技能自己的 `description` |
   | `/docker-manage prune stopped containers` | 同样的指令，任务文本 = 命令之后你写的那些字 |
   | `/docke` | 没有精确匹配 → 作为普通消息发给 Agent |
   | `please /docker-manage now` | 不在第 0 个位置 → 普通消息 |

**没有**关键词/tags 自动匹配，也**没有**「让 LLM 自己选技能」这一步。像「帮我看看 docker 状态」这样的自然语言
只有在模型恰好处于某个已选中技能的上下文时才会起作用 —— 本指南的旧版本声称会按 tags 自动匹配，而代码里不存在
这条路径。

列表的访问受权限控制：`/api/ai/getSkills` 接受 `skills` 或 `ai` 两个权限位里的任意一个，因为挑技能本来就是聊天的
一部分。

## Agent 实际收到了什么

一次运行带着技能启动时，服务端会往系统提示词后面追加：

```
## Current Task Instructions (Skill: <name>)

<整个技能正文>
```

值得知道的细节：

- 它的作用域是**一次运行**，不是一个持久模式。下一条不带技能的消息就没有这一段。
- 它是对基础系统提示词（里面已经带着终端上下文和工具定义）的*追加*，不是替换。
- 技能的 id 和名字会记在聊天历史里那条用户消息上，因此会话记录能看出哪个回答出自哪份手册，而对该消息「重试」
  会复用同一个技能。
- 技能不能授予能力。一句「重启所有服务」只有在这个账号的权限位、以及 Agent 自身的危险命令处理都放行时才会真的执行。
  Agent 引擎里的命令黑名单不会被手册文本绕过。
- 提示注入面：技能内容是被信任的输入，直接写进系统提示词。在共享实例上，任何能写技能的人都能为该账号操纵 Agent
  的行为 —— 这正是用户技能按归属隔离、以及未来的写入接口必须放在 `skills` 权限位之后的原因。

## 内置技能

随包发布的三份手册，都在 `data/skills`：

| id | name | 用途 |
|----|------|------|
| `server-health-check` | Server Health Check | 一趟采集各项指标（CPU、内存、磁盘、网络、进程、服务），通过一段能适配 Linux / macOS / Windows 的生成脚本完成 |
| `log-analyze` | Log Analysis | 错误模式识别、频次统计、跨 Nginx / 应用 / 系统日志的异常关联；需要吞吐的地方用脚本 |
| `docker-manage` | Docker Management | 容器生命周期、镜像/卷清理、网络排障、批量操作 |

把它们既当功能、也当范例来读：每一份都演示了 Agent 处理得最好的那种模式 —— 一段脚本一次采集，而不是二十个来回；
把平台差异明确写出来；以一个固定的输出形态收尾。

## 怎么写好技能

1. **说怎么做，不只是做什么。**「生成一个 bash 脚本，一趟把所有指标采集完」胜过「检查服务器」。对远端 shell 打
   来回既慢又吵。
2. **按名字点出平台差异。**
   ```markdown
   - **Linux**：服务用 `systemctl`
   - **macOS**：`launchctl`；没有 `systemctl`
   - **Windows**：PowerShell cmdlet（`Get-Service`、`Stop-Service`）；假设调用可能被 cmd 包了一层
   ```
3. **明确什么时候该写脚本而不是逐条执行命令** —— 超过约 3 步的顺序操作、循环、条件分支，或输出量很大时。
4. **写下 Agent 不容交易的安全规则。**
   ```markdown
   - reload 之前一定先跑 `nginx -t`
   - 结构性改动前备份配置
   - 本轮没有明确确认，绝不 `DROP DATABASE`
   ```
5. **钉死输出格式**，好让多次运行的结果可比：一行总结、指标表格、被标记的问题、建议。
6. **别假设那台机器能像你这样被访问到。** 任何改动之前先做只读探测（`command -v docker`、`nginx -v`），这样工具
   缺失时报的是一句清楚的错误，而不是一串连锁错误。
7. **保持简短。** 每一行都在和你同样希望模型读到的终端输出抢上下文。

## 完整示例

```markdown
---
name: Nginx Management
description: Manage Nginx web server - config validation, reload, SSL, troubleshooting
tags: [ops, nginx, web, ssl]
---

管理 Nginx 配置，并排查对外服务中的问题。

## 前置检查

在做任何其他事情之前，先确认 Nginx 存在：

    nginx -v 2>&1 || echo "Nginx not installed"

## 常用操作

配置校验 —— reload 之前**一定**要先跑：

    nginx -t

平滑重载（不中断服务）：

    systemctl reload nginx    # Linux
    launchctl kickstart -k system/org.macports.nginx   # macOS, MacPorts

查看当前生效的配置：

    cat /etc/nginx/nginx.conf
    ls /etc/nginx/sites-enabled/   # Debian/Ubuntu 的布局
    ls /etc/nginx/conf.d/          # RHEL/CentOS 的布局

证书有效期：

    echo | openssl s_client -connect localhost:443 -servername $(hostname) 2>/dev/null | openssl x509 -noout -dates

## 排障

502 Bad Gateway：先看上游服务状态，然后 `tail -50 /var/log/nginx/error.log`，再确认上游端口在监听
（`ss -tlnp`）。

内存或 CPU 偏高：`ps aux | grep nginx`，复核 `worker_connections`，检查打开文件数上限。

## 安全

- `nginx -t` 没通过之前，绝不 reload。
- 结构性改动前把配置复制成 `.bak`。
- TLS 相关的改动要用 `curl -vk https://localhost` 验过之后才算成功。

## 输出格式

1. 一行总结做了什么
2. 检查项与结果的表格
3. 遗留风险，逐条标记
```

## 调试

| 想确认的事 | 怎么确认 |
|------------|----------|
| 我的文件加载了吗？ | 启动日志：`[SkillService] Loaded N system skills (user skills are per-account, queried on demand)`。N 比预期小 → 往上找 `Failed to parse skill` 那一行 |
| front matter 被解析了吗？ | 面板里显示的是 id 而不是 `name` → front matter 没被识别（见[文件格式](#文件格式)那节约束） |
| 这个账号能看到哪些技能？ | 带上该账号的 Bearer 令牌调 `POST /api/ai/getSkills` —— 它返回的就是那份合并视图（内置 + 该归属下的行） |
| 技能真的注入提示词了吗？ | 会话记录里这一轮的用户消息带一个技能徽标；WS 的 `ai-agent-run` 帧带 `skillId`（DevTools → Messages） |
| 为什么 `/myskill` 没反应？ | id 不匹配（斜杠是对文件名做精确匹配），或者 `/` 不在第一个字符 |
| 我改的内容没出现 | 内置是启动时读的；重启后端 |

## 贡献技能

- 新增内置技能就是往 `data/skills/<kebab-case-id>.md` 放一个文件并提 PR。它对该部署上的**每个**账号都可见，
  所以要写成陌生人也能正确使用的样子：不要内网主机名、不要只对某个环境成立的假设、不要凭据 —— 见
  [CONTRIBUTING.md](../CONTRIBUTING.md)。
- 优先考虑改进现有那三份，而不是加一个近似重复的：面板里是把列表完整展示的，长列表很难扫。
- 技能是会被模型执行的一份文档。请像评审 shell 脚本一样评审它：一句错的「永远先做 X」，在真实主机上就是一条
  错的命令。
