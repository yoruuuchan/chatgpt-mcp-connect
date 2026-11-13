# chatgpt-mcp-connect

**把本地和远程 MCP Server 接进 ChatGPT 的可复现配方。**

你的 MCP 在 Claude Code 或 Cursor 里跑得好好的，ChatGPT 就是看不见它。这个仓库管的就是这最后一公里：十三条真正搭起来、跑通、验证过的路径，都写下来了，省得你再花一个下午重新踩一遍。

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

MCP 生态里没有哪样东西直接给你这四条。所有教程都停在「你的服务本地能跑了」。从这一步到一个真能用的 ChatGPT 连接器，中间那段空白，就是一个下午耗掉的地方。协议本身有文档，零件怎么拼没有。

这个仓库就是那份装配说明：哪个零件放哪，哪里会坏，坏了怎么判断是哪一层。

## 怎么开始

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git
cd chatgpt-mcp-connect
```

**0. 先决定你要暴露的是一个 MCP，还是一个 Runtime。** 如果你想让 ChatGPT 只连一个稳定入口，后面挂多个 Workspace、Skill 和上游 MCP，先看 [`recipes/mcpx`](./recipes/mcpx/)。MCPX 走的是聚合 / Runtime 路线。下面这张表管的是另一种：把单个叶子 MCP 直接接进 ChatGPT。

**1. 先对号入座。** 关于你要直接接入的那个 MCP，回答两个问题：

| 它支持 HTTP 吗？ | 它有 OAuth 吗？ | 去这里 |
|---|---|---|
| 支持 | 没有 | [`templates/oauth-gateway`](./templates/oauth-gateway/)：在它前面加一层 OAuth |
| 不支持（只有 stdio） | 没有 | [`recipes/blender`](./recipes/blender/)：先加桥，再加网关 |
| 支持 | 有 | [`recipes/devspace`](./recipes/devspace/)：你只需要把它暴露出去 |
| 不知道 | | [`docs/architecture.md`](./docs/architecture.md) |

如果上游本身已经是公网 HTTPS 上的 MCP，只是只给一个静态 Bearer/API Token，那就别再把流量绕回自己的电脑。直接参考 [`recipes/mcdonalds`](./recipes/mcdonalds/)：用 Cloudflare Worker 在边缘提供 ChatGPT 能吃的 OAuth，再把 OAuth bearer 换成上游 Token。

如果数据源是一台手机，而且它在移动网络上、离开电脑以后也得一直连得上，参考 [`recipes/listening-bridge`](./recipes/listening-bridge/)。手机只保持一条主动出站的持久 WebSocket，连到常驻服务器。ChatGPT 通过公网 HTTPS + OAuth 访问服务器上的 MCP。

**2. 照最接近的那条配方做。** 就算你的 MCP 不在这十三个里面，总有一条跟它是同一个形状。

**3. 碰 ChatGPT 之前，先自检。**

```bash
node scripts/doctor.mjs --url https://mcp.example.com --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771
```

它按顺序探测每一跳，直接告诉你第一个断掉的是哪一层。不用对着 ChatGPT 那个什么都不说的报错干猜。

```text
[  ok  ] 1. MCP server            127.0.0.1:8770 accepting connections
[ FAIL ] 2. OAuth gateway         gateway is up and reports upstream unreachable (HTTP 503)
         The gateway itself is fine — what sits behind it is down.
```

像 MCPX 这种自带 OAuth 的服务，不传 `--gateway`，把 `--upstream` 直接指向 MCPX 自己就行。

## 十三条配方

每一条都在真机上搭过、跑过，也都写清楚了：验证了什么，没验证什么，什么时候验证的。

| 配方 | 接的是什么 | 传输 | OAuth 方案 | 暴露方式 |
|---|---|---|---|---|
| [davinci-resolve](./recipes/davinci-resolve/) | 达芬奇 Studio：时间线、素材、调色、渲染 | 原生 HTTP | 本地网关 | Cloudflare Tunnel |
| [windows-desktop](./recipes/windows-desktop/) | Windows 桌面自动化，危险工具已关掉 | 原生 HTTP | 本地网关 | Cloudflare Tunnel |
| [blender](./recipes/blender/) | Blender 场景和 Python | stdio → 桥 → 插件 socket | 本地网关 | Cloudflare Tunnel |
| [qq-mail-mcp](./recipes/qq-mail-mcp/) | QQ 邮箱 IMAP/SMTP：搜索、读取、线程、附件、草稿、回复、发信 | stdio → 桥 | 本地网关 | 国内云主机上的 Cloudflare Tunnel |
| [comfyui](./recipes/comfyui/) | ComfyUI 工作流和生成 | 原生 HTTP | Cloudflare Worker | Worker + Tunnel |
| [mcdonalds](./recipes/mcdonalds/) | 麦当劳中国官方托管 MCP：账户、优惠券、菜单、订单 | 托管 Streamable HTTP | Cloudflare Worker 上套一层 OAuth | Worker 自定义域名，无 Tunnel |
| [listening-bridge](./recipes/listening-bridge/) | Android MediaSession 元数据与播放控制，通过手机主动出站 WebSocket 汇入云端 | 云端 Streamable HTTP | 云端主机上的本地网关 | Cloudflare Tunnel；HTTPS/WSS 分离域名 |
| [kimi-computer-use](./recipes/kimi-computer-use/) | 桌面 computer-use agent | stdio → 桥 | Cloudflare Access，零代码 | Cloudflare Tunnel |
| [devspace](./recipes/devspace/) | 本地代码工作区：文件、搜索、shell | 原生 HTTP | 自带 | Cloudflare Tunnel（Tailscale Funnel 备选） |
| [webcodex](./recipes/webcodex/) | 项目工具 + 控制台，跑在 WSL 的 Docker 里 | 原生 HTTP | 自带 | Tunnel，本地 YAML |
| [unreal-engine](./recipes/unreal-engine/) | 虚幻编辑器：Actor、蓝图、材质、Niagara、Sequencer | 原生 HTTP，Epic 自己的编辑器内服务 | 本地网关 | Cloudflare Tunnel |
| [mcpx](./recipes/mcpx/) | MCP Runtime：Workspace、持久会话、Skill、上游 MCP 聚合 | 原生 HTTP | 自带 | Cloudflare Tunnel |

差异本身就是重点。这十三条配方加起来，覆盖了四种做 OAuth 的方式，从一行代码都不写，到自己跑一个网关。公网暴露也有好几种：现在部署用的是 Cloudflare Tunnel、Worker 自定义域名等；没有域名或不用 Cloudflare 的时候，还保留了 Tailscale Funnel 作为备选。MCPX 又多了一层架构选择：让 ChatGPT 直接连叶子 MCP，还是在前面放一个 Runtime，统一承载会变化的一组本地能力。想选路线看 [`docs/architecture.md`](./docs/architecture.md)，想横向对比看 [`recipes/`](./recipes/)。

## 仓库里有什么

```text
recipes/     十三条验证过的完整路径，其中一条是 Runtime 聚合路径
templates/   oauth-gateway/  — 给任意 HTTP MCP 套上 OAuth 2.1
             supervisor/     — 让这些进程在重启后还活着
scripts/     doctor.mjs      — 分层连通性自检，零依赖
docs/        架构 · 安全 · 排错
SKILL.md     Agent skill：让 Claude Code / Codex 直接读这个仓库
```

大多数人真正缺的是两样东西。一个是 [`templates/oauth-gateway`](./templates/oauth-gateway/)：两百多行 Node，能把一个普通 HTTP MCP 变成 ChatGPT 能通过认证的地址。另一个是 [`docs/troubleshooting.md`](./docs/troubleshooting.md)，里面记的都是真踩过的坑，没有「可能会出问题」那种清单。其中代价最大的一个：**所有认证失败都返回 HTTP 500 而不是 401**。两个毫不相干的原因，造出了一模一样的症状。

## 当 Agent Skill 用

这个仓库也能当编码 Agent 的 Skill 用。新开一个会话，Agent 直接从架构读起，不用先花半天重新考古「ChatGPT 到底支不支持 MCP」。

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.claude/skills/chatgpt-mcp-connect   # Claude Code
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.agents/skills/chatgpt-mcp-connect   # Codex
```

然后在全局 `CLAUDE.md` 或 `AGENTS.md` 里加一句：

> 当任务涉及把自定义 MCP 接入 ChatGPT / GPT 时，必须先读取并遵循 `chatgpt-mcp-connect` skill。

## 边界

它能给你：一个真正能用、有认证、重启后还活着的公网 MCP 地址，外加一个出问题时能告诉你哪一层坏了的工具。它也会告诉你，什么时候该用一个 Runtime 统一接入，不必给每个叶子 MCP 单独搭一套连接链路。

它不是 MCP 框架，不是要装的代理，不是托管服务，也不是沙箱。它不 fork、也不包装任何上游 MCP。每条配方都指向真正的原项目，只告诉你怎么配。

它也**不限制**通过认证之后的调用方能做什么。暴露任何东西之前，先读 [`docs/security.md`](./docs/security.md)，尤其是「把你不需要的工具关掉」那一段。

各条配方的验证时间：

- 最初一批桌面配方：2026-08-18
- Unreal：2026-08-19
- 麦当劳公网托管 + 边缘 OAuth 路径、MCPX Runtime：2026-08-21
- QQ 邮箱，在常驻 Linux 云主机上：2026-09-05
- Listening Bridge 的手机主动出站 WebSocket 路径，在 vivo 真机上：2026-09-11

2026-09-09，DevSpace 的公网暴露层从 Tailscale Funnel 迁到了 Cloudflare Tunnel。原来的 Funnel 路径作为实测过的备选方案留在文档里。

每条配方都写明了当天实测了什么、没实测什么。验证时应用本身没开着的，配方里就直说，不含糊过去。

## 上游致谢

这里每一个 MCP 都是别人的项目。这个仓库只链接，不复制、不 fork。

| 项目 | License | 用在哪 |
|---|---|---|
| [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp) | MIT | 达芬奇 |
| [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT | Windows 桌面 |
| [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) | MIT | Blender |
| [honest-magic/mail-mcp](https://github.com/honest-magic/mail-mcp) | MIT | QQ 邮箱 IMAP/SMTP |
| [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) | MIT | ComfyUI |
| [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT | DevSpace，以及 gateway 模板复用的 `SingleUserOAuthProvider` |
| [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex) | Apache-2.0 | WebCodex |
| [opentokenz/mcpx](https://github.com/opentokenz/mcpx) | Apache-2.0 | MCP Runtime / 聚合配方 |
| [sugarforever/amap-mcp-server](https://github.com/sugarforever/amap-mcp-server) | 见上游仓库 | MCPX 配方里的上游 MCP 示例 |
| [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) | MIT | stdio → Streamable HTTP 桥 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 | OAuth 路由和 Bearer 校验 |
| [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) | MIT | ComfyUI 和麦当劳配方的边缘 OAuth |
| [麦当劳中国 MCP](https://open.mcd.cn/mcp/doc) | 官方托管服务，非开源 | 麦当劳配方用的官方 MCP |
| [yoruuuchan/listening-bridge](https://github.com/yoruuuchan/listening-bridge) | MIT | Android → 主动出站 WebSocket → 云端 MCP 配方 |
| [EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) | MIT | 虚幻引擎 Agent Skill |
| Unreal MCP（`ModelContextProtocol`） | 随虚幻 5.8 一起发布，UE EULA | 虚幻引擎 |
| Moonshot Kimi CU | 闭源，未找到公开条款 | computer-use 配方（只链接，不分发任何文件） |

这些项目都没有为这里的配方背书，也不负责维护。配方的 bug 是这个仓库的问题；上游的 bug 请提到上游去。

## 参与

欢迎新的配方，前提是你真的跑通了。照现有配方的结构写，写清楚你的测试环境和日期。没验证的地方就标成没验证，别脑补填上。修正已经过时的配方同样有用，这些上游项目迭代都很快。

## License

MIT，见 [LICENSE](./LICENSE)。上游项目各自保留自己的 License。
