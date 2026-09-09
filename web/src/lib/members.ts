/**
 * members.json 的类型与展示层回退约定（见 AGENTS.md「展示层回退约定」）。
 * 构建期在 .astro frontmatter 中使用；浏览器端 <script> 不依赖本文件（零运行时 JS 依赖）。
 */

export interface MemberRecord {
  wxid: string;
  alias: string;
  nickName: string;
  displayName: string;
  /** 采集者备注；public 模式（默认）下整个字段不存在（见 config.omittedFields） */
  remark?: string;
  /** 站点根相对路径 avatars/<wxid>.webp；无头像为 null */
  avatar: string | null;
  msgCount: number;
}

export interface MembersConfig {
  groupName: string;
  /** 群简称，用于 <title>；采集时未配置则等于 groupName */
  groupShortName: string;
  year: number;
  collectedAt: string;
  dataCutoff: string;
  memberCount: number;
  countingRule: string;
  /** public：可部署 / 分享；private：含采集者私有字段，仅本机预览 */
  mode: "public" | "private";
  /** 本文件删除了哪些成员字段 */
  omittedFields: string[];
}

export interface MembersData {
  config: MembersConfig;
  members: MemberRecord[];
}

/** 昵称里的控制字符（实测有人昵称是 4 个 U+007F）渲染为空白，剔掉后再判空 */
function cleanName(s: string): string {
  return s.replace(/\p{Cc}/gu, "").trim();
}

export const NO_NAME = "（无昵称）";

/** 展示名：群昵称 → 微信昵称 → 占位。不用 remark（采集者视角），也不用 wxid 充当名字 */
export function displayNameOf(m: MemberRecord): string {
  return cleanName(m.displayName) || cleanName(m.nickName) || NO_NAME;
}

/** 头像占位：展示名的首个"用户可感知字符"（正确处理 emoji / 组合字符），无法取到时用 "?" */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === NO_NAME) return "?";
  // Intl.Segmenter 按 grapheme 切分，避免把 emoji / 代理对劈成两半
  const seg = new Intl.Segmenter("zh", { granularity: "grapheme" });
  const first = seg.segment(trimmed)[Symbol.iterator]().next().value;
  return first ? first.segment : "?";
}

/** 占位底色：按 wxid 稳定哈希到色相环，同一人每次构建颜色一致 */
export function hueOf(wxid: string): number {
  let h = 0;
  for (let i = 0; i < wxid.length; i++) h = (h * 31 + wxid.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 搜索索引：把可检索文本拼成一个小写字符串，挂到 data-search 上供浏览器端过滤 */
export function searchTextOf(m: MemberRecord): string {
  return [m.displayName, m.nickName, m.alias, m.remark ?? ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** 中位数；空数组返回 0。偶数个时取中间两数平均 */
export function medianOf(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const lo = s[mid - 1] ?? 0;
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : (lo + hi) / 2;
}

/**
 * 活跃门槛：发过言成员发言数的中位数，向上取整（发言数是整数，≥ 26.5 等价于 ≥ 27）。
 * 不用全员中位数——半数以上成员是 0 条，全员中位数恒为 0，无区分度。
 */
export function activeThresholdOf(members: MemberRecord[]): number {
  const spoke = members.filter((m) => m.msgCount > 0).map((m) => m.msgCount);
  return Math.ceil(medianOf(spoke));
}

/** 2026-09-08T00:56:54+08:00 → 2026-09-08 00:56 */
export function formatDateTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}
