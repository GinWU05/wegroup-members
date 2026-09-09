/**
 * members.json 的类型与展示层回退约定（见 AGENTS.md「展示层回退约定」）。
 * 构建期在 .astro frontmatter 中使用；浏览器端 <script> 不依赖本文件（零运行时 JS 依赖）。
 */

export interface MemberRecord {
  /** 微信内部 id；public 模式（默认）下整个字段不存在（见 config.omittedFields） */
  wxid?: string;
  /** 微信号；public 模式下整个字段不存在 */
  alias?: string;
  nickName: string;
  displayName: string;
  /** 采集者备注；public 模式下整个字段不存在 */
  remark?: string;
  /** 站点根相对路径 avatars/<hash>.webp（盐化哈希，不含 wxid）；无头像为 null */
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

/**
 * 占位底色：按种子字符串稳定哈希到色相环。
 * 种子优先 wxid（private），public 产物无 wxid 时用头像路径 / 展示名兜底（见 seedOf）
 */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 占位色种子：wxid → 头像路径（盐化哈希，同人稳定）→ 展示名 */
export function seedOf(m: MemberRecord): string {
  return m.wxid || m.avatar || displayNameOf(m);
}

/** 搜索索引：把可检索文本拼成一个小写字符串，挂到 data-search 上供浏览器端过滤 */
export function searchTextOf(m: MemberRecord): string {
  return [m.displayName, m.nickName, m.alias ?? "", m.remark ?? ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * 分位数：p ∈ [0, 1]，返回从小到大排列后位于 p 处的值（落在两数之间时线性插值）。
 * p = 0.5 就是中位数；空数组返回 0。
 */
export function quantileOf(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = s[Math.floor(pos)] ?? 0;
  const hi = s[Math.ceil(pos)] ?? 0;
  return lo + (hi - lo) * (pos - Math.floor(pos));
}

/** 活跃 = 发言数排进发过言成员的前 25%（页面文案也用这个数，改这里两处同步） */
export const ACTIVE_TOP_PERCENT = 25;

/**
 * 活跃门槛：发过言成员发言数的前 25% 分位（即 P75），向上取整。
 * - 0 条者不参与：半数以上成员从不发言，算进去会把门槛压到 0
 * - 用分位数不用平均数：群聊发言是长尾分布，平均数会被头部几人拉走；分位数对分布形状不敏感，换群不调参
 * - 选 25% 而非 50%：实测中位数门槛 27 条/年（每月 3 条）叫“活跃”太勉强，前 25% 门槛 255 条（约每天 1 条）符合直觉
 */
export function activeThresholdOf(members: MemberRecord[]): number {
  const spoke = members.filter((m) => m.msgCount > 0).map((m) => m.msgCount);
  return Math.ceil(quantileOf(spoke, 1 - ACTIVE_TOP_PERCENT / 100));
}

/** 2026-09-08T00:56:54+08:00 → 2026-09-08 00:56 */
export function formatDateTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}
