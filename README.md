# 微信桥接器 (Weixin Agent Bridge)

分布式微信 AI 智能体接入与路由桥接系统，基于腾讯微信官方 iLink AI Bot 协议实现。支持通过单个微信账号路由并调度多个本地或远程 AI 智能体（如 Codex、Antigravity 等）。

---

## 🌟 核心特性

- **官方协议接入**：直接对接腾讯官方 iLink AI Bot (`ilinkai.weixin.qq.com`)，终端扫码登录，告别封号风险。
- **分布式多节点路由**：
  - **Server 节点**：负责微信连接、消息分发与本地 Agent 执行。
  - **Client 节点**：部署在多台远程云主机上，通过安全 Token 向 Server 注册并心跳保活。
- **微信端交互控制**：
  - `/agents`：列出所有在线的智能体节点（本机与远程）。
  - `/agent <client-id>`：一键切换当前微信会话绑定的 Agent。
  - `/agent status`：查看当前绑定的智能体状态。
- **多智能体执行引擎适配（v0.3.1+）**：
  - 原生支持 **Codex**、**Claude Code** (`claude`)、**OpenCode** (`opencode`) 以及 **Google Antigravity** (`agy`) 等主流 Agent CLI。
  - 通过 `WEIXIN_AGENT_TYPE` 灵活指定引擎，或通过自动探测无缝兼容。
  - 提供 `node weixin-agent-bridge.mjs executor` 快速检测与验证当前节点的执行引擎。
- **多模态与通用适配**：
  - 支持文本提示词、图片、文件附件传输。
  - 可通过 `WEIXIN_AGENT_BIN` / `WEIXIN_CODEX_BIN` 无缝接入自定义命令行智能体。
- **安全与策略控制**：
  - 节点间采用 Bearer Token 安全认证与主机名白名单控制。
  - 沙箱级别、执行目录（CWD）、审批策略及超时时间由各节点本地强制隔离，远程无法越权篡改。

---

## 📁 目录结构

```text
weixin-bridge/
├── server/      # 微信路由中心服务与本地执行端
├── client/      # 远程 Agent 执行节点
├── skill/       # 适用于 AI Agent 的技能定义包（Skill）
└── README.md
```

---

## 🚀 快速开始

### 1. 服务端部署（Server）

在作为中心网关的机器上安装 Node.js 22+：

```bash
cd server
# 1. 扫码登录微信
node weixin-agent-bridge.mjs login

# 2. 启动服务中心（默认端口 8787）
export WEIXIN_SERVER_PORT=8787
export WEIXIN_CODEX_CWD=/path/to/project
node weixin-agent-bridge.mjs server
```
> 服务端首次启动会自动生成通信秘钥（存放在 `~/.codex/weixin-agent-bridge/server/server.secret`）。

### 2. 远程客户端部署（Client）

在需要执行任务的远程云主机上：

```bash
cd client
export WEIXIN_SERVER_HOSTNAME="server.yourdomain.com"
export WEIXIN_SERVER_PORT=8787
export WEIXIN_SERVER_SCHEME=http # 或 https
export WEIXIN_SERVER_SECRET="服务端生成的secret"
export WEIXIN_CLIENT_ID="cloud-server-1"
export WEIXIN_CLIENT_PUBLIC_URL="http://client.yourdomain.com:8788"
export WEIXIN_AGENT_TYPE="codex" # 可选: codex / claude / opencode / agy
export WEIXIN_CODEX_CWD=/path/to/remote/project

node weixin-agent-bridge.mjs client
```

### 3. 在微信中使用

在微信中给机器人发送消息：
- 发送 `/agents` 查看所有在线 Agent
- 发送 `/agent cloud-server-1` 切换到指定的远程 Agent
- 发送普通文字或图片/文件，Agent 会在指定服务器执行并返回回复

---

## 📄 详细文档

- [服务端配置指南](server/README.md)
- [客户端配置指南](client/README.md)
- [部署与运维参考](skill/references/deployment.md)
- [通信协议与 API 规范](skill/references/protocol.md)
