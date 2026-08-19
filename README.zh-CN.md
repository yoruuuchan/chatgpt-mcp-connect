# chatgpt-mcp-connect

**把本地和远程 MCP Server 接进 ChatGPT 的可复现配方。**

你的 MCP 在 Claude Code 或 Cursor 里跑得好好的，ChatGPT 就是看不见它。这个仓库解决的就是这最后一公里——八条真正搭起来、跑通、验证过的路径，写下来，省得你再花一个下午重新踩一遍。

[English](./README.md) · [架构](./docs/architecture.md) · [安全](./docs/security.md) · [排错](./docs/troubleshooting.md)

---

## 为什么需要这个

ChatGPT 要连上你的 MCP，下面四条必须**同时**成立：

| ChatGPT 要求 | 大多数 MCP 的现状 |
|---|---|
| 公网 HTTPS 地址 | 只监听 `127.0.0.1` |
| Streamable HTTP 传输 | stdio |
| OAuth 2.1，带动态客户端注册和 PKCE | 没有认证，或者只有一个静态 API key |
| 工具数量在它能接受的范围内 | 作者写了多少就是多少 |

MCP 生态里没有任何东西直接给你这四条。所有教程都停在「你的 server 本地能跑了」，而从这里到一个真正能用的 ChatGPT connector 之间的那段空白，就是时间消失的地方。协议本身有文档，怎么把零件拼起来没有。

这个仓库就是那份装配说明：哪个零件放在哪，哪里会坏，以及坏了怎么判断是哪一层坏的。

## 怎么开始

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git
cd chatgpt-mcp-connect
```

**1. 先对号入座。** 回答关于你那个 MCP 的两个问题：

| 它说 HTTP 吗？ | 它有 OAuth 吗？ | 去这里 |
|---|---|---|
| 有 | 没有 | [`templates/oauth-gateway`](./templates/oauth-gateway/)——在它前面加一层 OAuth |
| 没有（只有 stdio） | 没有 | [`recipes/blender`](./recipes/blender/)——先加桥，再加 gateway |
| 有 | 有 | [`recipes/devspace`](./recipes/devspace/)——你只需要把它暴露出去 |
| 不知道 | | [`docs/architecture.md`](./docs/architecture.md) |

**2. 照最接近的那条 recipe 做。** 就算你的 MCP 不在这八个里面，总有一个跟你形状一样。

**3. 碰 ChatGPT 之前先自检。**

```bash
node scripts/doctor.mjs --url https://mcp.example.com --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771
```

它按顺序探测每一跳，直接告诉你第一个断掉的是哪一层——而不是让你对着 ChatGPT 那个什么都不说的报错自己猜。

```
[  ok  ] 1. MCP server            127.0.0.1:8770 accepting connections
[ FAIL ] 2. OAuth gateway         gateway is up and reports upstream unreachable (HTTP 503)
         The gateway itself is fine — what sits behind it is down.
```

## 八条 recipe

每一条都在真机上搭过、跑过。每一条都写清楚了验证了什么、没验证什么、什么时候验证的。

| Recipe | 接的是什么 | 传输 | OAuth 方案 | 暴露方式 |
|---|---|---|---|---|
| [davinci-resolve](./recipes/davinci-resolve/) | 达芬奇 Studio——时间线、素材、调色、渲染 | 原生 HTTP | 本地 gateway | Cloudflare Tunnel |
| [windows-desktop](./recipes/windows-desktop/) | Windows 桌面自动化，危险工具已关掉 | 原生 HTTP | 本地 gateway | Cloudflare Tunnel |
| [blender](./recipes/blender/) | Blender 场景和 Python | stdio → 桥 → 插件 socket | 本地 gateway | Cloudflare Tunnel |
| [comfyui](./recipes/comfyui/) | ComfyUI 工作流和生成 | 原生 HTTP | **Cloudflare Worker** | Worker + Tunnel |
| [kimi-computer-use](./recipes/kimi-computer-use/) | 桌面 computer-use agent | stdio → 桥 | **Cloudflare Access，零代码** | Cloudflare Tunnel |
| [devspace](./recipes/devspace/) | 本地代码工作区——文件、搜索、shell | 原生 HTTP | 自带 | **Tailscale Funnel** |
| [webcodex](./recipes/webcodex/) | 项目工具 + 控制台，跑在 WSL 的 Docker 里 | 原生 HTTP | 自带 | Tunnel，本地 YAML |
| [unreal-engine](./recipes/unreal-engine/) | 虚幻编辑器——Actor、蓝图、材质、Niagara、Sequencer | 原生 HTTP，**Epic 自己的编辑器内服务** | 本地 gateway | Cloudflare Tunnel |

**这种差异本身就是重点。** 八条 recipe 之间覆盖了**四种做 OAuth 的方式**——从一行代码都不写，到自己跑一个 gateway——以及**三种拿到公网域名的方式**，取舍都写清楚了。想选路线看 [`docs/architecture.md`](./docs/architecture.md)，想横向对比看 [`recipes/`](./recipes/)。

## 仓库里有什么

```
recipes/     八条验证过的完整路径
templates/   oauth-gateway/  — 给任意 HTTP MCP 套上 OAuth 2.1
             supervisor/     — 让这些进程在重启后还活着
scripts/     doctor.mjs      — 分层连通性自检，零依赖
docs/        架构 · 安全 · 排错
SKILL.md     Agent skill：让 Claude Code / Codex 直接读这个仓库
```

大多数人真正缺的是两样东西。一个是 [`templates/oauth-gateway`](./templates/oauth-gateway/)——两百多行 Node，把一个普通 HTTP MCP 变成 ChatGPT 能通过认证的 endpoint。另一个是 [`docs/troubleshooting.md`](./docs/troubleshooting.md)，里面是**真的踩过的坑**，不是「可能会出问题的地方」清单。其中代价最大的一个：**所有认证失败都返回 HTTP 500 而不是 401**，而且是两个毫不相干的原因造出了一模一样的症状。

## 当 Agent Skill 用

这个仓库同时是一个给编码 Agent 的 skill。新开一个会话时，Agent 直接从架构开始，而不是先花半天重新考古「ChatGPT 到底支不支持 MCP」。

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.claude/skills/chatgpt-mcp-connect   # Claude Code
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.agents/skills/chatgpt-mcp-connect   # Codex
```

然后在全局 `CLAUDE.md` 或 `AGENTS.md` 里加一句：

> 当任务涉及把自定义 MCP 接入 ChatGPT / GPT 时，必须先读取并遵循 `chatgpt-mcp-connect` skill。

## 边界

**它给你的**：一个真正能用、有认证、重启后还活着的公网 MCP endpoint，外加一个出问题时能告诉你是哪一层坏了的工具。

**它不是**：MCP 框架、要装的代理、托管服务、沙箱。它不 fork 也不包装任何上游 MCP——每条 recipe 都指向真正的原项目，只告诉你怎么配。它也**不限制**通过认证之后的调用方能做什么——暴露任何东西之前先读 [`docs/security.md`](./docs/security.md)，尤其是「把你不需要的工具关掉」那一段。

**验证于 2026-08-18**，Unreal 那条是 **2026-08-19**，环境是 Windows 11 + WSL2，隧道走 Cloudflare 和 Tailscale。每条 recipe 都写明了那天实测了什么、没实测什么——验证时应用本身没开着的，recipe 里就直说，不含糊过去。

## 上游致谢

这里每一个 MCP 都是别人的项目。这个仓库只链接，不复制、不 fork。

| 项目 | License | 用在哪 |
|---|---|---|
| [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp) | MIT | 达芬奇 |
| [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT | Windows 桌面 |
| [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) | MIT | Blender |
| [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) | MIT | ComfyUI |
| [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT | DevSpace，以及 gateway 模板复用的 `SingleUserOAuthProvider` |
| [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex) | Apache-2.0 | WebCodex |
| [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) | MIT | stdio → Streamable HTTP 桥 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 | OAuth 路由和 Bearer 校验 |
| [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) | MIT | ComfyUI recipe 的边缘 OAuth |
| [EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) | MIT | 虚幻引擎 agent skill |
| Unreal MCP（`ModelContextProtocol`） | 随虚幻 5.8 一起发布，UE EULA | 虚幻引擎 |
| Moonshot Kimi CU | 闭源，未找到公开条款 | computer-use recipe——只链接，不分发任何文件 |

这些项目都没有背书或维护这里的 recipe。recipe 的 bug 是这个仓库的问题；上游的 bug 请提到上游去。

## 参与

欢迎新的 recipe，前提是你真的跑通了。照现有 recipe 的结构写，写清楚你的测试环境和日期，没验证的地方就标成没验证，不要脑补填上。修正已经过时的 recipe 同样有价值——这些上游项目迭代都很快。

## License

MIT，见 [LICENSE](./LICENSE)。上游项目各自保留自己的 License。
