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
├── agents.md              # 本文件
├── scripts/               # 数据采集层（本地运行，Node 或 Python）
│   └── collect.*          # 参数化：--group <群名> --year <年> --out <路径>
├── web/                   # Web 展示层（静态站，Vite）
│   ├── src/
│   └── public/
│       ├── data/          # members.json（gitignore，构建时注入）
│       └── avatars/       # 本地化头像（gitignore）
└── .gitignore             # data/、avatars/、含群 ID 的本地配置
```

### 采集层（scripts/）

1. 读 `group.local.json` 拿群配置，经 chatroom 接口取当前成员列表（wxid + displayName）
2. 读 `contact.db`（只读）批量补齐：alias、nickName、remark、`small_head_url`，并经 `chatroom_member` 校验成员身份
3. 按月分片拉取今年（当年 1 月 1 日 ~ 采集日）全部群消息，`seq` 去重，按 sender wxid 聚合发言次数
   - **统计口径**：排除系统消息（type=10000）与无 sender / sender=`系统消息` 的记录；其余类型（文本 1、图片 3、视频 43、**表情包 47 算发言**、链接/引用/文件 49 等）全部计为发言。口径写入 `config.countingRule` 并在站点明示
   - **退群成员（保留反悔余地）**：数据层保留今年**所有**发言者——含已退群者，用 `inGroup: false` 标记，contact 信息尽力补齐。展示层用开关决定是否显示已退群者，默认值待定，改口径不需重新采集
4. 头像下载到本地 `avatars/<wxid>.png`（HTTPS + `wx.qlogo.cn` 校验 + 大小限制，失败/缺失降级首字母）
5. 产出统一 schema 的 `members.json`：

```jsonc
{
  "config": {
    "groupName": "...",
    "year": 2026,
    "collectedAt": "...",     // 采集时刻
    "dataCutoff": "...",      // Chatlog 快照中该群最新一条消息的时间
    "memberCount": 448,
    "countingRule": "..."     // 统计口径自述，站点页脚展示
  },
  "members": [
    {
      "wxid": "...",
      "alias": "...",         // 微信号；实测多数成员为空，展示层按缺省处理
      "nickName": "...",
      "displayName": "...",   // 群昵称；可能为空 → 展示回退链 displayName → nickName → 首字母
      "remark": "...",        // 我方备注；群主（本人）已决定可公开
      "avatar": "avatars/<wxid>.png",
      "msgCount": 123,        // 不在字段名嵌年份，年份看 config.year
      "inGroup": true         // false = 今年发过言但已退群
    }
  ]
}
```

### Web 层（web/）

- 静态站，Vite + 轻量框架（细节实现时定），读 `members.json` 渲染
- 布局方向：顶部群概览（群名、成员数、统计年份、数据截止时间、统计口径）+ 成员卡片墙
- 默认按年度发言次数从高到低排序，支持搜索/筛选
- 已退群成员显示开关（数据层已保留，展示口径可随时反悔）
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
- 脱敏开关保留为构建期能力（万一日后想收紧字段），但默认全量输出

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
- 退群成员：数据层全量保留（`inGroup` 标记），展示层开关控制，默认值待定 —— 反悔只改开关不重采
- 不追踪入群时间（YAGNI）：成员墙只记录采集时点的当前成员 + 今年发言者

## 数据纪律（继承自 chatlog-story-daily skill）

- 只查询目标群与所需时间范围，原始数据留在本地
- `contact.db` 只读打开（`?mode=ro`），仅为读取头像 URL 与联系人属性，不算引入新解密工具（读的是 Chatlog 自己已解密的库）
- 发言统计只用实际计数，不估算；数据截止时间在站点上明示
- 头像按 wxid 解析并校验群成员身份，绝不按昵称匹配
- 不解密 `.dat` 附件、不引入 vchat / wechat-decrypt 等新工具
- 不自动向微信群投递任何产物

## 实现里程碑

- [ ] M1 采集脚本：群成员（chatroom API）+ 联系人信息（contact.db 只读）+ 年度发言计数（按月分片）→ `members.json`
- [ ] M2 头像本地化：下载 / 校验 / 缓存 / 降级
- [ ] M3 Web 站点：卡片墙 + 排序 + 搜索 + 退群成员开关
- [ ] M4 脱敏开关（构建期能力，默认全量输出）+ 退群成员默认口径拍板
- [ ] M5 CF Pages 部署（**必须 CF Access 或口令**）
- [ ] M6（可选）域名购买与绑定
