#!/usr/bin/env node
/**
 * M1 采集脚本：群成员 + 联系人信息 + 年度发言计数 → members.json
 *
 * 数据源：
 *   1. Chatlog HTTP API（chatroom 成员列表、chatlog 消息记录）
 *   2. Chatlog 已解密的 contact.db（只读）：alias / nick_name / remark / small_head_url
 *
 * 用法：
 *   node scripts/collect.mjs [--config group.local.json] [--year 2026] [--out web/public/data]
 *
 * 产出：
 *   <out>/members.json            —— 站点数据（含全部字段，公开口径见 AGENTS.md）
 *   data/avatar-manifest.json     —— wxid → 头像 URL 清单，供 M2 下载用（不部署）
 *
 * 统计口径（详见 AGENTS.md「统计与成员口径」）：
 *   - 排除系统消息（type=10000）与无 sender / sender=系统消息 / sender 非法（Chatlog
 *     对部分引用消息会把 XML 塞进 sender 字段）的记录
 *   - 其余类型（文本/图片/视频/表情包/链接引用等）全部计为发言
 *   - 只统计采集时点的当前群成员；已退群者的发言不计入（决策 2026-09-07）
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { config: "group.local.json", year: new Date().getFullYear(), out: "web/public/data" };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--config") args.config = argv[++i];
    else if (key === "--year") args.year = Number(argv[++i]);
    else if (key === "--out") args.out = argv[++i];
    else {
      console.error(`未知参数: ${key}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(args.year) || args.year < 2000 || args.year > 2100) {
    console.error(`--year 非法: ${args.year}`);
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv);
const log = (...xs) => console.error(`[collect]`, ...xs);

// ---------- 配置 ----------

const cfg = JSON.parse(readFileSync(resolve(args.config), "utf8"));
for (const k of ["groupName", "chatroomId", "chatlogBase", "contactDb"]) {
  if (!cfg[k]) {
    console.error(`配置缺少字段: ${k}（${args.config}）`);
    process.exit(1);
  }
}
const contactDbPath = cfg.contactDb.replace(/^~(?=\/)/, homedir());

// ---------- 1. 群成员列表（Chatlog chatroom API）----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

log(`查询群成员: ${cfg.chatroomId}`);
const chatroomResp = await fetchJson(
  `${cfg.chatlogBase}/api/v1/chatroom?keyword=${encodeURIComponent(cfg.chatroomId)}&format=json`
);
const room = (chatroomResp.items ?? []).find((it) => it.name === cfg.chatroomId);
if (!room) {
  console.error(`chatroom API 未找到精确匹配: ${cfg.chatroomId}`);
  process.exit(1);
}
/** @type {Map<string, string>} wxid -> 群内 displayName */
const currentMembers = new Map(room.users.map((u) => [u.userName, u.displayName ?? ""]));
log(`当前成员: ${currentMembers.size} 人（群主: ${room.owner}）`);

// ---------- 2. 年度消息按月分片拉取 + 计数 ----------

/** ISO 8601 含本地时区偏移（与 Chatlog 返回的 dataCutoff 格式一致，如 2026-09-07T23:02:20+08:00） */
function isoLocal(d) {
  const offMin = -d.getTimezoneOffset();
  const pad = (n) => String(Math.abs(n)).padStart(2, "0");
  const local = new Date(d.getTime() + offMin * 60000).toISOString().slice(0, 19);
  return `${local}${offMin >= 0 ? "+" : "-"}${pad(Math.trunc(offMin / 60))}:${pad(offMin % 60)}`;
}

const now = new Date();
const collectedAt = isoLocal(now);
const lastMonth = args.year === now.getFullYear() ? now.getMonth() + 1 : 12;

const seenSeq = new Set(); // seq 去重
/** @type {Map<string, number>} sender wxid -> 发言条数 */
const speakers = new Map();
let dataCutoff = "";
let totalCounted = 0;
let totalExcluded = 0;

// wxid 合法格式：字母数字下划线连字符等（Chatlog 偶发把消息 XML 塞进 sender，必须过滤）
const WXID_RE = /^[A-Za-z0-9_\-@.]+$/;

for (let m = 1; m <= lastMonth; m++) {
  const mm = String(m).padStart(2, "0");
  const lastDay = new Date(args.year, m, 0).getDate(); // 当月最后一天
  const range = `${args.year}-${mm}-01~${args.year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  const msgs = await fetchJson(
    `${cfg.chatlogBase}/api/v1/chatlog?talker=${encodeURIComponent(cfg.chatroomId)}&time=${range}&format=json`
  );
  let counted = 0;
  for (const msg of msgs) {
    const key = `${msg.seq}|${msg.sender}`;
    if (seenSeq.has(key)) continue;
    seenSeq.add(key);
    if (msg.time > dataCutoff) dataCutoff = msg.time;
    // 口径：排除系统消息、无 sender、sender 非法（XML 污染）
    if (msg.type === 10000 || !msg.sender || msg.sender === "系统消息" || !WXID_RE.test(msg.sender)) {
      totalExcluded++;
      continue;
    }
    speakers.set(msg.sender, (speakers.get(msg.sender) ?? 0) + 1);
    counted++;
  }
  totalCounted += counted;
  log(`${range}: ${msgs.length} 条，计入 ${counted}`);
}
log(`发言合计 ${totalCounted} 条（排除 ${totalExcluded} 条系统/无主消息），发言者 ${speakers.size} 人`);
log(`数据截止: ${dataCutoff}`);

// ---------- 3. contact.db（只读）补齐联系人属性 ----------

log(`读取 contact.db: ${contactDbPath}`);
const db = new DatabaseSync(contactDbPath, { readOnly: true });

const roomRow = db
  .prepare("SELECT id FROM contact WHERE username = ?")
  .get(cfg.chatroomId);
if (!roomRow) {
  console.error(`contact.db 中未找到群: ${cfg.chatroomId}`);
  process.exit(1);
}
/** chatroom_member 校验集（群成员身份，供头像纪律使用） */
const dbMemberIds = new Set(
  db
    .prepare(
      "SELECT c.username FROM chatroom_member m JOIN contact c ON c.id = m.member_id WHERE m.room_id = ?"
    )
    .all(roomRow.id)
    .map((r) => r.username)
);
log(`contact.db chatroom_member 记录: ${dbMemberIds.size} 人`);

const contactStmt = db.prepare(
  "SELECT username, alias, nick_name, remark, small_head_url FROM contact WHERE username = ?"
);

// 口径：只输出当前成员；已退群者的发言不计入榜单
let leftSpeakers = 0;
let leftMsgs = 0;
for (const [wxid, count] of speakers) {
  if (!currentMembers.has(wxid)) {
    leftSpeakers++;
    leftMsgs += count;
  }
}
log(`已退群发言者 ${leftSpeakers} 人、${leftMsgs} 条，按口径不计入`);

const AVATAR_URL_RE = /^https:\/\/wx\.qlogo\.cn\//;
const members = [];
const avatarManifest = {};
let noContact = 0;
let noAvatar = 0;

for (const wxid of currentMembers.keys()) {
  const c = contactStmt.get(wxid); // 精确匹配 username，无模糊命中风险
  if (!c) noContact++;
  const avatarUrl = c?.small_head_url ?? "";
  const avatarOk = AVATAR_URL_RE.test(avatarUrl);
  if (!avatarOk) noAvatar++;
  else avatarManifest[wxid] = avatarUrl;

  members.push({
    wxid,
    alias: c?.alias ?? "",
    nickName: c?.nick_name ?? "",
    // 纯群昵称（chatroom API），未设置为 ""；不用消息 senderName 兜底（它会混入我方 remark），回退交给展示层
    displayName: currentMembers.get(wxid) ?? "",
    remark: c?.remark ?? "",
    avatar: avatarOk ? `avatars/${wxid}.png` : null,
    msgCount: speakers.get(wxid) ?? 0,
  });
}
db.close();

members.sort(
  (a, b) => b.msgCount - a.msgCount || a.wxid.localeCompare(b.wxid)
);

// ---------- 4. 输出 ----------

const output = {
  config: {
    groupName: cfg.groupName,
    year: args.year,
    collectedAt,
    dataCutoff,
    memberCount: currentMembers.size,
    countingRule:
      "统计当年群内全部消息，排除系统消息（撤回/入退群提示等）；文本、图片、视频、表情包、链接与引用均计为发言。仅统计采集时的当前群成员，已退群者不计入。",
  },
  members,
};

const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "members.json");
writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n");

const manifestFile = resolve("data/avatar-manifest.json");
mkdirSync(dirname(manifestFile), { recursive: true });
writeFileSync(manifestFile, JSON.stringify(avatarManifest, null, 2) + "\n");

log(`✅ ${outFile}`);
log(`   成员条目 ${members.length}，其中今年有发言 ${members.filter((x) => x.msgCount > 0).length} 人`);
log(`   contact.db 无记录 ${noContact} 人；无有效头像 ${noAvatar} 人（降级首字母）`);
log(`✅ ${manifestFile}（${Object.keys(avatarManifest).length} 个头像 URL，供 M2 下载）`);
