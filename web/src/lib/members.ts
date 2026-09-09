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

/** 展示名：群昵称 → 微信昵称。不用 remark（采集者视角） */
export function displayNameOf(m: MemberRecord): string {
  return m.displayName || m.nickName || m.wxid;
}

/** 头像占位：展示名的首个"用户可感知字符"（正确处理 emoji / 组合字符），无法取到时用 "?" */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
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

/** 2026-09-08T00:56:54+08:00 → 2026-09-08 00:56 */
export function formatDateTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}
