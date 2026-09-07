# wegroup-members

微信群成员信息收集与展示站。从本地 Chatlog 服务提取指定微信群的成员信息（微信号、昵称、备注、头像），统计年度发言次数并排序，生成静态 Web 站点部署到 Cloudflare Pages。

## 项目定位

- **性质**：个人 / 社区项目，非商用
- **命名**：`wegroup-members` —— 通用命名，架构上支持提取任意微信群。
- **首个目标群**：见 `group.local.json`（命中 `.gitignore` 的 `*.local.json` 规则，永不入库）。群名、chatroom id、contact.db 路径等群特定信息一律只存该文件（或 CI 环境变量），不写入包括本文件在内的任何入库文件

## 核心依赖

1. **[Chatlog](https://github.com/imldy/chatlog)**：已运行在 `http://127.0.0.1:5030/`，不引入任何新解密/抓取工具
   - `GET /api/v1/chatroom?keyword=<群名>&format=json` → 群信息 + 成员列表（wxid、群内 displayName）
   - `GET /api/v1/chatlog?talker=<chatroom>&time=<起>~<止>&format=json` → 消息记录（`limit`/`offset` 实测有效；实测单次拉 14 万条也可行，但采集按月分片 + `seq` 去重更稳）
   - `GET /api/v1/contact?keyword=<wxid>&format=json` → **仅** userName/alias/remark/nickName/isFriend，**无头像字段**，且 keyword 为模糊匹配（必须校验返回 `userName === 请求 wxid`）
   - **头像与完整联系人属性来源：Chatlog 已解密的 SQLite `contact.db`**（路径见 `group.local.json`），只读打开，取 `contact.small_head_url` / `alias` / `nick_name` / `remark`，经 `chatroom_member` 表校验群成员身份。实测目标群 448/448 在 contact 表有记录，446/448 有 `wx.qlogo.cn` 头像；alias 仅 34/448 有值（微信数据本身限制，非好友大多为空）
2. **Skill: `productivity/chatlog-story-daily`**（位于 `~/.hermes/skills/productivity/chatlog-story-daily/`）
   - 复用其头像解析纪律：按 wxid 解析（绝不按昵称）→ 校验群成员身份 → 仅接受 HTTPS `wx.qlogo.cn` 头像 URL → 限制下载大小 → 本地缓存 → 失败降级为首字母占位
   - 复用其数据新鲜度原则：采集"今年"数据前确认 Chatlog 快照覆盖到最新，报告中注明数据截止时间
   - 参考脚本：`scripts/resolve_avatars.py`

## 架构：采集与展示分离

```
wegroup-members/
├── AGENTS.md              # 本文件
├── package.json           # pnpm；scripts: collect / typecheck / lint / lint:fix / format
├── tsconfig.json          # strict，noEmit，erasableSyntaxOnly（Node 原生跑 .ts，无构建步骤）
├── biome.json             # Biome 统一 lint + format
├── scripts/               # 数据采集层（本地运行）
│   ├── collect.ts         # 参数化：--config <群配置> --year <年> --out <路径> [--avatars-dir <路径>] [--no-avatars] [--private]
│   └── lib/avatars.ts     # M2 头像下载/校验/缓存/清理
├── web/                   # Web 展示层（静态站，Vite）
│   ├── src/
│   └── public/
│       ├── data/          # members.json（gitignore，构建时注入）
│       └── avatars/       # 本地化头像（gitignore）
├── group.local.json       # 群特定配置（gitignore）
└── .gitignore             # data/、avatars/、*.local、*.local.json
```

### 工程约定

- **运行时**：Node ≥ 22.18，`.ts` 直接跑（原生 type stripping），不引入 tsx/ts-node/构建步骤；因此 `tsconfig` 开 `erasableSyntaxOnly`，禁用 enum / namespace / 参数属性等不可擦除语法
- **包管理**：pnpm，`packageManager` 字段锁版本
- **代码质量**：Biome 一个工具包 lint + format（不同时上 ESLint + Prettier）；`tsc --noEmit` 做类型检查
- **提交前自查**：`pnpm lint:fix && pnpm typecheck`；仓库不内置 git hook，隐私防线靠 `.gitignore` 与本机本地措施
- **常用命令**：`pnpm collect`（采集，可追加 `-- --year 2025`）/ `pnpm collect:private`（隐私模式，产物可直接分享给群成员）/ `pnpm lint:fix` / `pnpm typecheck`

### 采集层（scripts/）

1. 读 `group.local.json` 拿群配置，经 chatroom 接口取当前成员列表（wxid + displayName）
2. 读 `contact.db`（只读）批量补齐：alias、nickName、remark、`small_head_url`，并经 `chatroom_member` 校验成员身份
3. 按月分片拉取今年（当年 1 月 1 日 ~ 采集日）全部群消息，`seq` 去重，按 sender wxid 聚合发言次数
   - **统计口径**：排除系统消息（type=10000）与无 sender / sender=`系统消息` 的记录；其余类型（文本 1、图片 3、视频 43、**表情包 47 算发言**、链接/引用/文件 49 等）全部计为发言。口径写入 `config.countingRule` 并在站点明示
   - **退群成员**：只输出采集时点的当前成员；已退群者的发言不计入榜单（脚本日志打印被排除的人数/条数以便核对）
   - **非法 sender**：Chatlog 对部分引用消息会把消息 XML 塞进 `sender` 字段，用 `^[A-Za-z0-9_\-@.]+$` 校验 wxid 格式，不合法的归入排除（实测约 200 条/年）
4. 头像下载到本地 `avatars/<wxid>.<ext>`（`scripts/lib/avatars.ts`）：
   - **准入**：URL 必须 `https://wx.qlogo.cn/`，且 wxid 经 `chatroom_member` 确认为群成员；重定向每一跳重新校验 host，最多 3 跳
   - **响应校验**：`Content-Type: image/*` → 流式读取上限 512 KB（不信任 Content-Length）→ 魔数必须 JPEG/PNG/GIF/WEBP，扩展名按真实格式落盘（实测约 90% JPEG，`/132` 规格单张 ~3 KB）
   - **缓存**：`data/avatar-cache.json` 记 wxid → {url, file}，URL 未变且文件在则不重下；全量 445 张首次 ~13 s，命中缓存 ~0 s
   - **清理**：每次采集后删除目录内不属于本次成员的旧头像与残留 `.tmp`，保证磁盘文件 == members.json 引用
   - **降级**：任一步失败 → `avatar: null`，日忘打印原因，展示层首字母占位；`--no-avatars` 可跳过下载只跑统计
5. 产出统一 schema 的 `members.json`：

```jsonc
{
  "config": {
    "groupName": "...",       // 群名
    "year": 2026,             // 统计年份
    "collectedAt": "...",     // 采集时间
    "dataCutoff": "...",      // 数据截止时间
    "memberCount": 447,       // 成员数
    "countingRule": "...",    // 统计口径
    "omittedFields": []       // 隐私模式下被删除的字段名；全量模式为 []
  },
  "members": [                // 按 msgCount 降序
    {
      "wxid": "...",          // 微信内部 id
      "alias": "...",         // 微信号
      "nickName": "...",      // 微信昵称
      "displayName": "...",   // 群昵称
      "remark": "...",        // 采集者备注；隐私模式下删除
      "avatar": "...",        // 站点根相对路径 avatars/<wxid>.<jpg|png|gif|webp>，可 null
      "msgCount": 123         // 发言数
    }
  ]
}
```

展示层回退约定：

- **展示名**：`displayName` → `nickName`（不使用 `remark`，它是采集者视角不是本人视角；可作副标题或搜索字段）
- **头像**：`avatar` → 展示名首字符占位
- **微信号**：`alias` → 为空时不展示该行（不用 wxid 顶替，避免把系统分配的 wxid_xxx 当微信号误导读者）
- 空值统一用 `""`（字符串字段）或 `null`（仅 `avatar`），不省略字段、不用 `undefined`。唯一例外：隐私模式下 `config.omittedFields` 列出的字段整个不存在，展示层按可选字段处理（不要硬编码字段名，读 `omittedFields`）

### Web 层（web/）

- 静态站，Vite + 轻量框架（细节实现时定），读 `members.json` 渲染
- 布局方向：顶部群概览（群名、成员数、统计年份、数据截止时间、统计口径）+ 成员卡片墙
- 默认按年度发言次数从高到低排序，支持搜索/筛选
- 群名、主题色等来自 `members.json` 的 `config` 字段 → 换群不改代码

### 部署

- Cloudflare Pages，只部署 `web/` 构建产物 + JSON + 头像
- **硬规则：部署必须带 CF Access 或口令**（决策 2026-09-06）。取得群成员/群主同意后才可评估切换公开

## 关键决策记录

### 1. 开源 vs 闭源

核心原则：**代码无害，数据有害** —— 代码与数据彻底分离后可安全开源。

- 仓库只含采集脚本 + Web 模板；`data/`、`avatars/`、`*.local.json`（群特定配置）全部 gitignore
- **公开字段决策（2026-09-06，本人拍板）**：`alias`、`wxid`、`remark` 均允许进入公开产物；头像文件名直接用 wxid（无需 hash）
- 注意：CF Pages 部署即数据可见（受访问控制约束，见部署节）。上线前仍需征得群成员/群主同意
- **隐私模式**：`pnpm collect:private`（`--private`）。目的是保护群成员隐私，使 `members.json` 可直接分享给群成员；默认 `pnpm collect` 仍全量输出
  - **删除字段清单只有一个事实来源**：`scripts/collect.ts` 的 `PRIVATE_STRIPPED_FIELDS`（当前：`remark`）。类型为 `(keyof Member)[]`，写错字段名或字段已从 schema 删除时 `typecheck` 直接报错；剥离逻辑、日忘、`config.omittedFields` 全部由它派生。日后要收紧更多字段（如 `alias`）只改这一行
  - 产物自描述：`config.omittedFields` 写明删了哪些字段，全量模式为 `[]`，展示层不硬编码

### 2. 通用性 / monorepo

**现在不上 monorepo，但做参数化**（YAGNI）：

- 采集脚本以 `--group` / `--year` / `--out` 参数化，不写死群名
- Web 层依赖约定 schema 的 JSON，群相关信息全在 `config` 字段
- `scripts/` + `web/` 平铺单 repo。第二个群出现时再决定：复制 repo / 抽模板 / 升级 pnpm workspace，届时迁移成本都很低

### 3. 域名

域名候选与群名强相关，属群特定信息，不写入本文件。候选清单、RDAP 实测结果与选型理由见本地笔记（Obsidian `note_dev/01-项目/wegroup-members.md`）。

通用原则：优先短、可扩子域（`members.<domain>` / `daily.<domain>`）；三字母 SLD 在部分注册局属溢价域名，下单前到 Cloudflare Registrar / Porkbun 核实实际价格。

### 4. 统计与成员口径（2026-09-06）

- 表情包（type=47）**算**发言；系统消息（type=10000）与无 sender 记录**不算**
- 退群成员：**不统计**（2026-09-07 拍板）。成员墙只含采集时点的当前成员，已退群者的发言不计入榜单。实测首次采集时只影响 22 人，简化优于保留开关
- 不追踪入群时间（YAGNI）：成员墙只记录采集时点的当前成员
- `displayName` 只取 chatroom API 的纯群昵称，**不用消息里的 `senderName` 兜底**：实测 Chatlog 的 senderName 会优先展示我方 remark，会把备注混进群昵称字段。回退交给展示层

## 数据纪律（继承自 chatlog-story-daily skill）

- 只查询目标群与所需时间范围，原始数据留在本地
- `contact.db` 只读打开（`?mode=ro`），仅为读取头像 URL 与联系人属性，不算引入新解密工具（读的是 Chatlog 自己已解密的库）
- 发言统计只用实际计数，不估算；数据截止时间在站点上明示
- 头像按 wxid 解析并校验群成员身份，绝不按昵称匹配
- 不解密 `.dat` 附件、不引入 vchat / wechat-decrypt 等新工具
- 不自动向微信群投递任何产物

## 实现里程碑

- [x] M1 采集脚本：群成员（chatroom API）+ 联系人信息（contact.db 只读）+ 年度发言计数（按月分片）→ `members.json`
- [x] M2 头像本地化：下载 / 校验 / 缓存 / 清理 / 降级（`scripts/lib/avatars.ts`，实测 445/445）
- [ ] M3 Web 站点：卡片墙 + 排序 + 搜索
- [x] M4 隐私模式：`collect:private`，删除字段清单集中在 `PRIVATE_STRIPPED_FIELDS`（默认仍全量）
- [ ] M5 CF Pages 部署（**必须 CF Access 或口令**）
- [ ] M6（可选）域名购买与绑定
