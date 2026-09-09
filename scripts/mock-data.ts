#!/usr/bin/env node
/**
 * 生成一套纯虚构的示例数据（members.json + 渐变头像），用于：
 *   - 没有微信/Chatlog 数据时本地预览站点效果
 *   - README 截图（不暴露任何真实群数据）
 *
 * 输出与 collect.ts 的 public 模式 schema 完全一致（omittedFields: wxid/alias/remark）。
 * 伪随机数用固定种子，产出可复现（时间戳除外，用固定假时间）。
 *
 * 用法：
 *   pnpm mock          —— 然后 pnpm web:dev / pnpm web:build
 *
 * 注意：会覆盖 web/src/data/members.json 与清空 web/public/avatars/；
 *       重新跑 pnpm collect 即可恢复真实数据（头像有缓存，重下很快）。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const OUT_DIR = resolve("web/src/data");
const AVATARS_DIR = resolve("web/public/avatars");
const YEAR = new Date().getFullYear();

// ---------- 可复现伪随机（mulberry32） ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260909);

// ---------- 虚构昵称池（全部为泛用网名，不指向任何真实个人） ----------

interface NamePair {
  /** 群昵称；空串演示回退到微信昵称 */
  d: string;
  /** 微信昵称；与群昵称不同时卡片显示副标题 */
  n: string;
}

const NAMES: NamePair[] = [
  { d: "摸鱼大师", n: "Fisher" },
  { d: "咖啡续命中", n: "espresso" },
  { d: "夜行的猫", n: "夜行的猫" },
  { d: "Bug 制造机", n: "反向 debug" },
  { d: "重构狂魔", n: "refactor4ever" },
  { d: "CSS 魔法师", n: "cascade" },
  { d: "异步人生", n: "await me" },
  { d: "内存泄漏", n: "OOM" },
  { d: "山顶洞人", n: "山顶洞人" },
  { d: "需求粉碎机", n: "PRD Shredder" },
  { d: "热心市民小王", n: "小王" },
  { d: "console.log", n: "打印大法" },
  { d: "undefined", n: "not a function" },
  { d: "打工人 007", n: "007" },
  { d: "干饭第一名", n: "干饭王" },
  { d: "颈椎康复中", n: "颈椎康复中" },
  { d: "秃头预备役", n: "发际线保卫战" },
  { d: "键盘侠本侠", n: "机械键盘收藏家" },
  { d: "深夜写码", n: "night owl" },
  { d: "白日梦想家", n: "白日梦想家" },
  { d: "一只前端", n: "fe_dev" },
  { d: "全栈咸鱼", n: "salted fish" },
  { d: "退堂鼓演奏家", n: "退堂鼓十级" },
  { d: "薛定谔的需求", n: "薛定谔的需求" },
  { d: "格子衫收藏家", n: "plaid" },
  { d: "早睡冠军", n: "23:00 睡" },
  { d: "反卷先锋", n: "躺平学首席" },
  { d: "摆烂艺术家", n: "摆烂艺术家" },
  { d: "代码洁癖", n: "clean coder" },
  { d: "扫地僧", n: "扫地僧" },
  { d: "小镇做题家", n: "做题家" },
  { d: "赛博养生", n: "枸杞配可乐" },
  { d: "电子木鱼", n: "功德 +1" },
  { d: "🐟 带薪摸鱼", n: "摸鱼中" },
  { d: "🚀 上线不回滚", n: "deploy on friday" },
  { d: "🔧 修锅匠", n: "背锅侠" },
  { d: "🍜 面条代码", n: "spaghetti" },
  { d: "😴 挂机中", n: "AFK" },
  { d: "", n: "只有微信昵称" },
  { d: "临时工", n: "临时工" },
  { d: "半路出家", n: "转行第三年" },
  { d: "低调的辉", n: "辉" },
  { d: "永远在路上", n: "on the way" },
  { d: "产品经理之友", n: "PM whisperer" },
  { d: "西二旗徐师傅", n: "徐师傅" },
  { d: "面试官本官", n: "handwrite promise" },
  { d: "禁止摸鱼", n: "卷王本王" },
  { d: "月亮邮递员", n: "moon mail" },
];

// ---------- 成员生成：长尾发言分布 + 一批零发言 ----------

const N_SPOKE = 76;
const N_SILENT = 52;

interface MockMember {
  nickName: string;
  displayName: string;
  avatar: string | null;
  msgCount: number;
}

function nameAt(i: number): NamePair {
  const base = NAMES[i % NAMES.length] ?? { d: "热心群友", n: "热心群友" };
  if (i < NAMES.length) return base;
  // 名字池用完后加序号，保证不重名
  const suffix = ` ${String(Math.floor(i / NAMES.length) + 1).padStart(2, "0")}`;
  return { d: base.d && base.d + suffix, n: base.n + suffix };
}

/** Zipf 式长尾：第 i 名约 C / i^s，加一点抖动 */
function msgCountAt(rank: number): number {
  const c = 8600;
  const s = 1.13;
  const jitter = 0.85 + rng() * 0.3;
  return Math.max(1, Math.round((c / (rank + 1) ** s) * jitter));
}

const members: MockMember[] = [];
for (let i = 0; i < N_SPOKE + N_SILENT; i++) {
  const { d, n } = nameAt(i);
  const hasAvatar = rng() > 0.15;
  members.push({
    nickName: n,
    displayName: d,
    avatar: hasAvatar ? `avatars/mock-${String(i).padStart(3, "0")}.webp` : null,
    msgCount: i < N_SPOKE ? msgCountAt(i) : 0,
  });
}
members.sort((a, b) => b.msgCount - a.msgCount);

// ---------- 渐变头像（SVG → sharp → 256×256 WebP，与真实产物同规格） ----------

function avatarSvg(): string {
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 50 + Math.floor(rng() * 90)) % 360;
  const cx = 60 + Math.floor(rng() * 136);
  const cy = 60 + Math.floor(rng() * 136);
  const r = 50 + Math.floor(rng() * 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${h1}, 68%, 62%)"/>
      <stop offset="1" stop-color="hsl(${h2}, 62%, 42%)"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" fill="url(#g)"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${h2}, 70%, 88%, 0.35)"/>
  <circle cx="${256 - cx}" cy="${256 - cy}" r="${Math.floor(r * 0.6)}" fill="hsla(${h1}, 70%, 20%, 0.25)"/>
</svg>`;
}

rmSync(AVATARS_DIR, { recursive: true, force: true });
mkdirSync(AVATARS_DIR, { recursive: true });
let avatarCount = 0;
for (const m of members) {
  if (!m.avatar) continue;
  const file = m.avatar.replace("avatars/", "");
  await sharp(Buffer.from(avatarSvg())).webp({ quality: 82 }).toFile(resolve(AVATARS_DIR, file));
  avatarCount++;
}

// ---------- members.json（public 模式 schema） ----------

const output = {
  config: {
    groupName: "某某技术交流群（示例数据）",
    groupShortName: "示例群",
    year: YEAR,
    collectedAt: `${YEAR}-09-09T12:00:00+08:00`,
    dataCutoff: `${YEAR}-09-09T11:58:00+08:00`,
    memberCount: members.length,
    countingRule:
      "本页为随机生成的示例数据，仅用于预览站点效果。真实采集时：统计当年群内全部消息，排除系统消息（撤回/入退群提示等）；文本、图片、视频、表情包、链接与引用均计为发言。仅统计采集时的当前群成员，已退群者不计入。",
    mode: "public",
    omittedFields: ["wxid", "alias", "remark"],
  },
  members,
};

mkdirSync(OUT_DIR, { recursive: true });
const outFile = resolve(OUT_DIR, "members.json");
writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);

console.log(`[mock] ✅ ${outFile}`);
console.log(`[mock]    成员 ${members.length}（发过言 ${N_SPOKE}），头像 ${avatarCount} 张`);
console.log("[mock]    预览：pnpm web:dev；恢复真实数据：pnpm collect");
