# 跳板机与 SSH Agent 转发

[English](./jump-host.md) · **简体中文**

AetherOps 抵达内网主机的方式是：先登录跳板机，再由一段**启动脚本**完成第二跳。这里没有一个专门的
「跳板机」字段：一条连接被当作跳板机来对待，纯粹是因为它配了启动脚本。

```
browser / desktop ──SSH──▶ bastion ──SSH──▶ target host
                              │
                    startup script writes the
                    second-hop command into the shell
```

- [工作原理](#工作原理)
- [配置](#配置)
- [Agent 转发](#agent-转发)
- [配好你的 ssh-agent](#配好你的-ssh-agent)
- [目标机的系统信息](#目标机的系统信息)
- [多级跳转](#多级跳转)
- [排障](#排障)
- [安全建议](#安全建议)

## 工作原理

1. AetherOps 用 ssh2 连上跳板机，开一个交互式 shell 通道。
2. 通道就绪 **800 毫秒**后，去掉首尾空白的启动脚本会像被人敲进去一样写入 shell，后面跟一个换行。
3. 跳板机执行它 —— 通常是一条 `ssh` 命令 —— 终端此后显示的就是目标主机的 shell。
4. 下游的一切（终端输入、AI Agent、命令审计）作用在当前摆在它面前的那个 shell 上，跳成功后就是目标机。

把「跳转」实现成「往 shell 里敲一条命令」带来的后果：

- 这一跳**不是原子的，也不做校验**。如果 `ssh` 失败（密钥被拒、主机未知、超时），shell 会停在跳板机上，
  终端只是多显示了一段错误文本。没有任何机制会发现「这一跳没发生」。
- 因为第一跳是真实的交互式会话，第二跳继承的是跳板机允许的一切 —— 你仍然需要**从跳板机视角看**有效的
  目标机凭据。
- 时序是启发式的。链路慢或 MOTD 很长，都可能跑赢那 800 毫秒。

## 配置

在连接编辑器里：

| 字段 | 填什么 |
|------|--------|
| 名称 | 能同时说明两端的写法，例如 `bastion → prod-db-01` |
| 主机 / 端口 / 用户名 | **跳板机** —— 绝不是目标机 |
| 认证方式 | 面向跳板机的密钥、口令或自动 |
| 启动脚本 | 那条能抵达目标的命令 |
| SSH Agent 转发 | 如果第二跳要用你的密钥，就勾上 |

启动脚本示例：

```bash
ssh ubuntu@192.168.1.100
```

```bash
ssh -p 2222 admin@target-server.internal
```

```bash
sleep 1; ssh -J jump2.internal target.internal
```

请保持**一行**：它是作为一个整串写进 shell 的。如果跳板机会打印很长的 MOTD，在前面加一句 `sleep 1`
（内置延迟是 800 毫秒，且不按连接单独配置）。

## Agent 转发

勾上这个框，在服务端会做两件事：

1. 连接时把 `config.agent` 设为探测到的 agent socket —— Linux/macOS 上是 `$SSH_AUTH_SOCK`，
   Windows 上是固定的 OpenSSH 命名管道 `\\.\pipe\openssh-ssh-agent`。
2. 以 `agentForward: true` 打开 shell 通道，于是目标机（以及跳板机）可以通过转发出去的 socket 访问那个
   agent。

这意味着**跳板机上不存任何私钥** —— 签名动作发生在 agent socket 上。

**是哪台机器的 agent？** 是**运行 AetherOps 后端**那台机器的，因为那个进程才是 SSH 客户端。这个区别很要紧：

| 宿主 | 被转发的是谁的 agent |
|------|----------------------|
| Electron 桌面端、VS Code 插件 | 你自己的 —— 后端跑在你机器上，所以用的就是你本地的 agent |
| 共享的 Web 部署 | **服务端**的 agent，不是浏览器使用者的。你笔记本上的密钥并不可达 |

所以对共享的 Web 实例来说，agent 转发是一项运维级能力：要么服务器主机上有一个装着跳板机所信任密钥的 agent，
要么第二跳改用别的方式认证（把目标机密钥存在连接里、口令、或跳板机侧的密钥）。没有任何办法把浏览器用户的本地
agent 委托进一个远端后端。

如果找不到 agent，连接日志会说明，并且转发被静默跳过：

```
Agent forwarding 已请求但未检测到 SSH agent
No SSH agent detected. Agent forwarding will not work.
```

打开 `debug.sshDebug`（或 `AETHEROPS_SSH_DEBUG=1`）会把 ssh2 的协议跟踪打到终端里，这是确认「到底有没有发起过
一次 `auth agent` 请求」最快的办法。

## 配好你的 ssh-agent

### Linux / macOS

```bash
echo $SSH_AUTH_SOCK          # 非空 → 有 agent 在跑
ssh-add ~/.ssh/id_rsa
ssh-add -l                   # 列出已加载的密钥
```

如果一个都没在跑：

```bash
eval $(ssh-agent -s)
ssh-add ~/.ssh/id_rsa
```

macOS 上想跨重启保留（走钥匙串）：

```bash
ssh-add --apple-use-keychain ~/.ssh/id_rsa
```

### Windows

OpenSSH 的 agent 服务默认是**禁用**的。在管理员 PowerShell 里：

```powershell
Start-Service ssh-agent
Set-Service ssh-agent -StartupType Automatic
ssh-add $HOME\.ssh\id_rsa
ssh-add -l
```

如果这个能力还没装：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

注意 ssh2 用的管道路径是 Windows OpenSSH agent 创建的那一个。第三方 agent（比如 PuTTY 的 pageant）不暴露这个
管道，因此转发找不到它。

## 目标机的系统信息

普通 SSH 会话下，AetherOps 从登录 **MOTD** 里提取环境信息（后台捕获 3 秒），如果没有可用内容，退回到在独立
`exec` 通道上主动探测。

带启动脚本的会话不一样：缓存/捕获到的数据描述的会是*跳板机*，所以行为是刻意分开的：

- 是否属于跳板机会话，判据是启动脚本非空。
- 缓存的上下文会被**忽略**，每次都重新采集。
- 采集会等到会话至少**满 8 秒**为止，好给第二跳留出时间（脚本在 800 毫秒写入 + 一跳通常 2–5 秒）。
- 跳板机这一跳不能用 `exec` 通道 —— 那会跑在跳板机上 —— 所以探测脚本是**敲进交互式终端**的，再读回它的回显，
  并从捕获的文本里剥掉提示符行。
- 先探 OS 家族，再发与之匹配的采集脚本。在家族检测存在之前，对一个 Windows 目标发只认 bash 的探测脚本，产出
  只有看不懂的报错回显。
- 超时：家族探测 8 秒，采集脚本 15 秒（输出需静默 1.5 秒才算完成）。

实际意味着：

- 在一个新建的跳板机会话里问 AI「这台机器上有什么」，它可能要先等几秒才回答 —— 它在等那个沉降窗口。
- **服务器状态面板**描述的是它的探测跑在哪，而跳板机会话里那就是跳板机。面板和 AI 上下文对于「你在哪台机器上」
  不一定一致；跟随跳转走的是 AI 那份采集上下文。
- 把探测注入交互式 shell 是能在终端里看见的。如果你正在跑全屏程序（编辑器、`top`），这次注入会把它弄花 ——
  请在之前或之后采集上下文，不要在其间。
- 如果采集时跳转还没完成，报出来的环境就是跳板机的。提升可靠性的办法是让启动脚本「失败得更慢」而不是更快
  （例如 `ssh -o ConnectTimeout=10`），或者连上之后再隔几秒打开对话。

## 多级跳转

链式跳转就是一条多跳的启动脚本。

```bash
ssh -J jump2.internal target.internal
```

```bash
ssh jump2.internal -t 'ssh target.internal'
```

在跳板机支持的前提下优先用 `-J`（ProxyJump）：中间少几个交互式 shell，agent 的处理也更干净。
`-t … 'ssh …'` 会在中间那一跳强制分配伪终端，当下下一跳需要 TTY 时这是必需的。

整条链上的 agent 转发要求每一跳都把它传下去：本地 agent 转发到跳板机 1，而跳板机 2 必须是从跳板机 1 出发、
且转发仍然生效地抵达。中间主机都得有 `AllowAgentForwarding yes`（并且没被 `Match` 段收紧），密钥才能在最远端
仍然可用。

## 排障

| 症状 | 可能的原因 | 怎么查 |
|------|------------|--------|
| 第二跳报 `Permission denied (publickey)` | agent 转发没生效 | 连接日志里找到 agent socket 了吗？密钥加载了吗（`ssh-add -l`）？共享 Web 后端的情况下，带密钥的是不是**服务端**那个 agent？ |
| 脚本从没跑起来，shell 就停在跳板机上 | MOTD 太长 / 链路慢，跑赢了 800 毫秒那次写入 | 前面加 `sleep 1;` |
| 在你自己的终端里能跳，在 AetherOps 里不行 | 你的交互式 shell 有登录会话给的 `SSH_AUTH_SOCK`，后端进程没有 | 从一个 `echo $SSH_AUTH_SOCK` 非空的 shell 里启动后端，或者用 Windows 的 OpenSSH 服务 |
| 环境信息描述的是跳板机 | 探测在跳转完成前跑了，或者跳转失败 | 看终端：提示符是目标机的吗？过几秒再问一次 |
| 连上之后全屏程序坏掉 | 探测被敲进了交互式 shell | 跳板机会话的头 15 秒左右不要起 `top`/编辑器 |
| 第二跳报 `ssh: Could not resolve hostname` | 目标机名字只在目标网络内可解析 —— 而那时你已经在那儿了，所以这通常意味着跳转*没有*发生 | 确认提示符变了；用 IP 排除 DNS 因素 |
| 第二跳想用口令 | 在启动脚本里用 `sshpass` | 能用，但口令会出现在进程列表和终端回显里。优先用密钥 |

用 `sshpass`（本指南的旧版本就是这么写的）可以，但不推荐：

```bash
sshpass -p 'password' ssh user@target-server
```

这份凭据会出现在跳板机的进程列表里、终端里，以及命令审计记录里。它是「密钥还没铺完」时的临时绕过，不是一种
认证策略。

## 安全建议

1. 转发 agent，而不是把私钥复制到跳板机上。
2. 收紧跳板机权限：只开 SSH、不加别的服务，并限制它能抵达哪些目标。
3. 定期轮换密钥 —— 转发意味着你加载进 agent 的那把密钥，在它够得着的一切地方都可用。
4. 记住 AI Agent 操作的是**目标机** shell。审计轨迹里一次提示注入式的失误，就是一条真的执行过的命令；跳板机
   会话的 `audit` 记录要像对任何其他主机一样复核（见
   [accounts-and-permissions.zh.md](./accounts-and-permissions.zh.md#管理员代管)）。
5. 对一批跳板机连接执行批量命令（`can_use_batch`）会穿过跳转扩散出去 —— 爆炸半径是那些目标机，不是跳板机。
   请按这个事实授予权限位。
