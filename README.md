# chatgpt-mcp-connect
一个很小但很实用的 Agent Skill：**专门告诉 Claude Code、Codex 等工程 Agent，如何把自定义 MCP 接入 ChatGPT。**

这个 Skill 主要来自 **ChatGPT Plus 用户的实际使用场景**。

问题并不是 ChatGPT 没有自定义 MCP 能力，而是 OpenAI 对 Plus 这一档的公开说明非常少。当前公开帮助文档对完整 MCP 的套餐说明主要集中在 Business / Enterprise / Edu，对 Pro 也只明确写了部分能力；Plus 缺少同样清晰、完整的接入说明。

所以新开一个 Claude Code / Codex 会话时，Agent 很容易先怀疑“Plus 到底能不能接自定义 MCP”，然后重新查一遍文档和现有实现，才敢继续做。常见的重复确认包括：

- ChatGPT 到底能不能接自定义 MCP？
- 本地 MCP 怎么暴露给 ChatGPT？
- 要不要做 Remote MCP？
- OAuth 怎么接？
- Cloudflare Tunnel 能不能用？

这套 Skill 的目的就是把这些已经确认过的基础事实固定下来，让 Agent **直接从实现开始，而不是每次从头考古。**

## 它做什么

默认接入思路：

```text
现有 MCP
  ↓
Remote MCP / Streamable HTTP
  ↓
OAuth 2.1
  ↓
Cloudflare Tunnel 或已有公网 HTTPS Endpoint
  ↓
ChatGPT
  ↓
真实工具调用验收
```

它主要覆盖：

- 判断现有 MCP 怎么接给 ChatGPT
- 把本地 / 私有 MCP 变成 ChatGPT 可访问的 Remote MCP
- 本地 HTTP MCP 优先通过 Cloudflare Tunnel 暴露
- 配置 OAuth 2.1
- 在 ChatGPT 中完成自定义 MCP 接入
- 最后用真实 tool call 验收，而不是“部署成功就算完成”

## 为什么要做这个 Skill

因为对 Plus 用户来说，这类任务特别容易重复浪费时间：功能入口和实际能力可能已经存在，但公开说明不足，Agent 在新会话里往往没有一个稳定的起点。

理想情况：

```text
用户：把这个 MCP 接给 GPT

Agent：
读取 chatgpt-mcp-connect
  ↓
检查现有 MCP
  ↓
配置 Remote MCP / Cloudflare / OAuth
  ↓
接入 ChatGPT
  ↓
真实调用验收
```

而不是：

```text
用户：把这个 MCP 接给 GPT

Agent：
“ChatGPT 支持 MCP 吗？”
  ↓
查文档
  ↓
“现在叫 Connector 还是 App？”
  ↓
继续查
  ↓
“OAuth 有什么要求？”
  ↓
继续查
  ↓
半天过去了
```

这个仓库就是给 Agent 一个固定起点。

## 安装

### Codex

把仓库放到：

```text
~/.agents/skills/chatgpt-mcp-connect
```

Windows 通常是：

```text
%USERPROFILE%\.agents\skills\chatgpt-mcp-connect
```

例如：

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.agents/skills/chatgpt-mcp-connect
```

### Claude Code

把仓库放到：

```text
~/.claude/skills/chatgpt-mcp-connect
```

Windows 通常是：

```text
%USERPROFILE%\.claude\skills\chatgpt-mcp-connect
```

例如：

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.claude/skills/chatgpt-mcp-connect
```

## 推荐：加一条全局触发规则

只靠 Skill 自动发现，有时新会话未必会主动加载。

所以建议再在全局指令里加一句：

```md
当任务涉及把自定义 MCP 接入 ChatGPT / GPT 时，必须先读取并遵循用户级 Skill `chatgpt-mcp-connect`。
```

Codex 放到全局 `AGENTS.md`。

Claude Code 放到全局 `CLAUDE.md`。

这样以后新会话里只要说：

> 把这个 MCP 接给 GPT。

Agent 就应该先读取这个 Skill，再开始实现。

## 仓库结构

```text
chatgpt-mcp-connect/
├─ SKILL.md
├─ README.md
├─ LICENSE
└─ examples/
   ├─ cloudflare-tunnel.md
   └─ oauth.md
```

- [`SKILL.md`](./SKILL.md)：Agent 真正读取和执行的流程
- [`examples/cloudflare-tunnel.md`](./examples/cloudflare-tunnel.md)：本地 / 私有 MCP 使用 Cloudflare Tunnel 的接法
- [`examples/oauth.md`](./examples/oauth.md)：OAuth 2.1 接入参考

## 设计原则

这不是一份 OpenAI 官方文档的静态备份。

Skill 只保存相对稳定的工程路径：

```text
ChatGPT
  ↕
Remote MCP
  ↕
OAuth
  ↕
实际 MCP Server
```

像下面这些变化比较快的内容：

- ChatGPT 当前 UI 在哪里添加 MCP
- Developer Mode 的具体入口
- 套餐开放范围
- OAuth 元数据的最新要求
- OpenAI 产品命名变化

Agent 在真正执行任务时再查看最新官方文档。

这样既不会每次从零开始，也不会因为仓库里写死旧 UI 而被过时信息坑到。

## License

MIT
