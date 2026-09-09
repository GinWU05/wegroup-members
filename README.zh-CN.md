<div align="center">

# wegroup-members

**微信群成员墙 —— 年度发言统计，零 JS 静态站呈现。**

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Astro](https://img.shields.io/badge/Astro-7-BC52EE?logo=astro&logoColor=white)](https://astro.build/)
[![Biome](https://img.shields.io/badge/Biome-lint%20%2B%20format-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev/)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)](https://pages.cloudflare.com/)
[![Client JS](https://img.shields.io/badge/%E5%AE%A2%E6%88%B7%E7%AB%AF%20JS-%E9%9B%B6%20island-brightgreen)](#%EF%B8%8F-工作原理)
[![Privacy](https://img.shields.io/badge/%E9%9A%90%E7%A7%81-%E9%BB%98%E8%AE%A4%E5%AE%89%E5%85%A8-blueviolet)](#-隐私设计)

[English](./README.md) | 简体中文

</div>

---

从本地运行的 [Chatlog](https://github.com/imldy/chatlog) 服务提取指定微信群的成员信息（昵称、头像）与年度发言次数，生成静态成员墙站点，可部署到 Cloudflare Pages。

代码与群无关：通过本地配置文件指向任意群即可。**任何群特定数据都不会进入本仓库** —— 见[隐私设计](#-隐私设计)。

## ✨ 特性

- **成员卡片墙**：头像、展示名、发言数与名次，Astro 零 island 静态输出（浏览器不加载任何框架 JS，只有一段原生 `<script>` 做过滤/重排）
- **年度发言排行**：统计当年 1 月 1 日至采集日的消息，按 `seq` 去重，统计口径在站点上明示
- **活跃成员标识**：发言数排进发过言成员前 25%（P75 分位）者标为活跃；门槛构建期算好并展示在标签旁
- **发言数分布柱状图**：对数分桶，分界点只用 1-2-5 类"顺眼"数，自适应 10~30 根柱，按活跃/其他双色堆叠 —— 纯 HTML/CSS，不用 SVG
- **浏览器端搜索 / 排序 / 筛选**：按名称搜索；发言最多/最少/名称排序；全部/活跃/有发言范围切换
- **头像本地化**：严格校验后下载原图（HTTPS `wx.qlogo.cn` host 白名单、大小上限、魔数校验、解压炸弹防护），重编码为 256×256 WebP 并抹掉全部元数据；文件名为盐化哈希，不暴露 wxid
- **两种输出模式** —— 见下节。默认即安全模式。

## 🔀 输出模式

| 模式 | 命令 | 内容 | 可否部署 |
|---|---|---|---|
| **public**（默认） | `pnpm collect` | 从每条成员记录中删除 `wxid`、`alias`（微信号）、`remark`（采集者私人备注）。只保留群成员之间本就互相可见的信息：群昵称、微信昵称、头像、发言数。 | 可以 —— 这就是用于部署 / 分享给群成员的模式 |
| **private** | `pnpm collect:private` | 全量输出，含 `wxid` / `alias` / `remark`。仅供采集者本机浏览。站点检测到 private 产物时会挂 sticky 红色警示横幅。 | **不可。绝不部署。** |

删除字段清单只有一个事实来源：`scripts/collect.ts` 的 `PUBLIC_STRIPPED_FIELDS`，类型为 `(keyof Member)[]`，写错字段名 `typecheck` 直接报错。产物自描述：`config.mode` 与 `config.omittedFields` 告诉展示层删了什么，下游不做任何硬编码。

## ⚙️ 工作原理

```
Chatlog HTTP API          contact.db（只读）
（成员、消息记录）         （alias / 昵称 / 头像 URL）
        └──────────┬──────────────┘
                   ▼
        scripts/collect.ts  ──►  web/src/data/members.json   （gitignore）
        scripts/lib/avatars.ts ► web/public/avatars/*.webp   （gitignore）
                   ▼
              astro build   ──►  web/dist/  （数据构建期内联进 HTML）
```

`members.json` 在 Astro frontmatter 里 `import`，构建期读取、渲染完即丢；`web/dist/` 里没有任何 `.json`。

## 📋 前置要求

- Node.js ≥ 22.18（原生 type stripping 直接跑 `.ts`，不需要 tsx/ts-node/构建步骤）
- pnpm
- 本地运行的 [Chatlog](https://github.com/imldy/chatlog)（默认 `http://127.0.0.1:5030`），且其已解密的 `contact.db` 在磁盘上可读

## 🚀 快速开始

```bash
pnpm install

# 1. 创建群配置（gitignore，永远留在你本机）
cp group.example.json group.local.json
#    …然后编辑 group.local.json 填入你的群信息

# 2. 采集：成员 + 联系人信息 + 年度发言计数 + 头像
pnpm collect                      # public 模式（默认，可部署）
pnpm collect -- --year 2025       # 换个年份

# 3. 构建与预览
pnpm web:build                    # → web/dist/
pnpm web:preview
```

### `group.local.json` 字段

参见 [`group.example.json`](./group.example.json)：

| 字段 | 必填 | 说明 |
|---|---|---|
| `groupName` | ✔ | 群全名（作为标识保留在 `config` 中） |
| `groupShortName` | | 群简称，用于 `<title>` / `h1`；缺省时等于 `groupName` |
| `chatroomId` | ✔ | `xxx@chatroom` 形式的群 id，与 Chatlog chatroom API 精确匹配 |
| `chatlogBase` | ✔ | Chatlog HTTP 服务地址，如 `http://127.0.0.1:5030` |
| `contactDb` | ✔ | Chatlog 已解密的 `contact.db` 路径（只读打开；支持 `~` 展开） |

### CLI 参数

`scripts/collect.ts` 支持（追加在 `pnpm collect --` 之后）：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--config <path>` | `group.local.json` | 群配置文件 |
| `--year <n>` | 当前年份 | 统计年份（1 月 1 日 → 采集日） |
| `--out <dir>` | `web/src/data` | `members.json` 输出目录 |
| `--avatars-dir <dir>` | `web/public/avatars` | 头像 WebP 输出目录 |
| `--no-avatars` | 关 | 跳过头像下载（只跑统计；`avatar` 全为 `null`） |
| `--private` | 关 | private 模式（见上节） |

## 🧰 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm collect` | = `collect:public`：采集数据 + 头像，public 模式 |
| `pnpm collect:private` | 全量输出（含隐私字段）—— 仅本机自用 |
| `pnpm web:dev` | Astro 开发服务器 |
| `pnpm web:build` | 静态构建 → `web/dist/` |
| `pnpm web:preview` | 预览构建产物 |
| `pnpm typecheck` | `tsc --noEmit`（scripts）+ `astro check`（web） |
| `pnpm lint` / `pnpm lint:fix` | Biome lint（+ 自动修复） |
| `pnpm format` | Biome 格式化 |

## 📏 统计口径

- 排除系统消息（`type=10000`）与无 sender / sender 非法的记录（Chatlog 对部分引用消息会把 XML 塞进 `sender` 字段，因此 sender 按 wxid 格式校验）
- 其余类型全部计为发言：文本、图片、视频、**表情包**、链接/引用/文件
- 只统计采集时点的当前群成员；已退群者的发言不计入
- 精确口径与数据截止时间写入 `config.countingRule`，并在站点上明示

## 🔒 隐私设计

核心原则：**代码无害，数据有害** —— 所以二者彻底分离。

- **任何群特定内容都不入库。** `data/`、`web/src/data/`、头像目录、`*.local.json`、`.env*` 全部 gitignore。群名、chatroom id、本机路径只存在于 `group.local.json`（或 CI 环境变量），绝不出现在入库文件中
- **默认即安全。** 不加参数的 `pnpm collect` 产出的就是脱敏后的 public 产物；必须显式 `--private` 才输出全量，且预览 private 产物时站点会醒目警示
- **public 产物只展示群成员之间本就互相可见的信息** —— 群昵称、微信昵称、头像 —— 外加一个发言数。不含聊天内容、不含微信号、不含采集者备注
- **头像**：只从 `https://wx.qlogo.cn/` 下载、只为已校验的群成员下载（按 wxid 解析，绝不按昵称匹配；每一跳重定向重新校验 host），解码前先过大小与格式校验，重编码抹掉元数据，文件名为盐化哈希
- **数据不会隐式离开本机**：只查询目标群与所需时间范围；`contact.db` 只读打开
- **部署有门禁**：部署必须带 Cloudflare Access 或口令；转为公开访问前需征得群成员/群主同意。页面带 `noindex, nofollow`

## ☁️ 部署

数据不在 git 里，CF Pages 的"连 git 自动构建"走不通；本地构建后直接上传产物：

```bash
pnpm collect && pnpm web:build
wrangler pages deploy web/dist
```

**硬规则：部署必须带 Cloudflare Access 或口令保护。**

## 🙏 致谢

- [Chatlog](https://github.com/imldy/chatlog) —— 本项目读取的本地微信聊天记录服务
- [Astro](https://astro.build/) —— 静态站点框架
- [sharp](https://sharp.pixelplumbing.com/) —— 头像重编码

详细工程约定与决策记录见 [`AGENTS.md`](./AGENTS.md)。
