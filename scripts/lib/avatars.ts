/**
 * M2 头像本地化：按 wxid 下载 wx.qlogo.cn 原图，校验后本地缩放为固定规格 WebP，缓存、失败降级。
 *
 * 纪律（继承 chatlog-story-daily skill）：
 *   - 只接受 https://wx.qlogo.cn/ 的 URL；重定向每一跳都重新校验 host
 *   - Content-Type 必须 image/*，字节数上限 MAX_BYTES，魔数必须是 JPEG/PNG/GIF/WEBP，再交给 sharp 解码
 *   - 输出统一为 <wxid>.webp，边长 OUTPUT_SIZE；重新编码顺带抹掉原图 EXIF 等元数据
 *   - 缓存按 (wxid, url, 规格) 命中则不重下；改 OUTPUT_SIZE/质量需同步 bump SPEC
 *   - 任何一步失败 → 该成员无头像（avatar=null），展示层降级首字母
 *   - 目录内不属于本次成员的旧文件会被清理，保证磁盘文件 == members.json 引用
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ALLOWED_HOST = "wx.qlogo.cn";
const MAX_BYTES = 1024 * 1024; // 原图 /0 实测最大 ~160 KB；留余量但挡住异常响应
const MAX_SOURCE_EDGE = 4096; // 解码前按头信息拒绝超大尺寸（防解压炸弹）
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

/** 输出规格：边长 px 与 WebP 质量。改动后 bump SPEC 让缓存整体失效 */
const OUTPUT_SIZE = 256;
const WEBP_QUALITY = 82;
const SPEC = `webp-${OUTPUT_SIZE}-q${WEBP_QUALITY}`;

const OUTPUT_EXT = "webp";
const WXID_RE = /^[A-Za-z0-9_\-@.]+$/;
const AVATAR_FILE_RE = /^[A-Za-z0-9_\-@.]+\.(jpg|png|gif|webp)$/;

/** 缓存文件内容：wxid -> 上次成功处理的 URL、规格与落盘文件名 */
type AvatarCache = Record<string, { url: string; spec: string; file: string }>;

export interface AvatarSyncOptions {
  /** 头像落盘目录（站点 public/avatars） */
  dir: string;
  /** 缓存记录文件（不部署） */
  cacheFile: string;
  log: (msg: string) => void;
}

export interface AvatarSyncResult {
  /** wxid -> 文件名（不含目录），仅含成功落盘者 */
  files: Map<string, string>;
  stats: { cached: number; downloaded: number; failed: number; pruned: number };
  failures: Array<{ wxid: string; reason: string }>;
}

// ---------- 校验 ----------

function isAllowedUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === "https:" && p.hostname === ALLOWED_HOST;
  } catch {
    return false;
  }
}

/** 按魔数确认是受支持的图片格式；识别不出视为非法，不交给解码器 */
function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true; // GIF
  const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
  const webp = b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  return riff && webp;
}

/** 流式读取响应体，超过上限立即中止（不信任 Content-Length） */
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Buffer> {
  if (!body) throw new Error("空响应体");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`超过大小上限 ${cap} B`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---------- 下载 ----------

async function fetchImage(url: string): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(current)) throw new Error(`URL 不在白名单: ${current}`);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "wegroup-members/0.1" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`HTTP ${res.status} 无 Location`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) throw new Error(`Content-Type 非图片: ${ct || "(空)"}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error(`Content-Length ${declared} 超上限`);
    const bytes = await readCapped(res.body, MAX_BYTES);
    if (!looksLikeImage(bytes)) throw new Error("魔数非 JPEG/PNG/GIF/WEBP");
    return bytes;
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
}

// ---------- 缩放 ----------

/** 解码 → 居中裁方 → 缩放到 OUTPUT_SIZE → WebP。不保留任何元数据 */
async function toThumbnail(src: Buffer): Promise<Buffer> {
  const meta = await sharp(src, {
    animated: false,
    limitInputPixels: MAX_SOURCE_EDGE ** 2,
  }).metadata();
  if (!meta.width || !meta.height) throw new Error("无法读取图片尺寸");
  if (meta.width > MAX_SOURCE_EDGE || meta.height > MAX_SOURCE_EDGE) {
    throw new Error(`源图 ${meta.width}x${meta.height} 超过 ${MAX_SOURCE_EDGE}`);
  }
  return sharp(src, { animated: false })
    .rotate() // 按 EXIF 方向摆正后再丢元数据
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

// ---------- 缓存 ----------

function loadCache(path: string): AvatarCache {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as AvatarCache) : {};
  } catch {
    return {};
  }
}

/** 删除该 wxid 的所有已存在文件（换格式/换 URL 时清旧） */
function removeFilesFor(dir: string, wxid: string): void {
  for (const ext of ["jpg", "png", "gif", "webp"] as const) {
    const p = join(dir, `${wxid}.${ext}`);
    if (existsSync(p)) rmSync(p);
  }
}

// ---------- 主流程 ----------

/**
 * @param urls wxid -> 头像 URL（调用方已按 chatroom_member 校验成员身份）
 */
export async function syncAvatars(
  urls: Map<string, string>,
  opts: AvatarSyncOptions,
): Promise<AvatarSyncResult> {
  mkdirSync(opts.dir, { recursive: true });
  const cache = loadCache(opts.cacheFile);
  const result: AvatarSyncResult = {
    files: new Map(),
    stats: { cached: 0, downloaded: 0, failed: 0, pruned: 0 },
    failures: [],
  };

  const queue = [...urls.entries()];

  async function processOne(wxid: string, url: string): Promise<void> {
    if (!WXID_RE.test(wxid)) {
      result.stats.failed++;
      result.failures.push({ wxid, reason: "wxid 含非法字符，不作为文件名" });
      return;
    }
    // 缓存命中：同 URL、同规格、文件仍在
    const hit = cache[wxid];
    if (hit && hit.url === url && hit.spec === SPEC && existsSync(join(opts.dir, hit.file))) {
      result.files.set(wxid, hit.file);
      result.stats.cached++;
      return;
    }
    try {
      const raw = await fetchImage(url);
      const out = await toThumbnail(raw);
      const file = `${wxid}.${OUTPUT_EXT}`;
      removeFilesFor(opts.dir, wxid);
      const tmp = join(opts.dir, `${file}.tmp`);
      writeFileSync(tmp, out);
      renameSync(tmp, join(opts.dir, file)); // 原子落盘，避免半截文件
      cache[wxid] = { url, spec: SPEC, file };
      result.files.set(wxid, file);
      result.stats.downloaded++;
    } catch (e) {
      delete cache[wxid];
      result.stats.failed++;
      result.failures.push({ wxid, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // 固定并发的简易工作池
  async function worker(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await processOne(next[0], next[1]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 清理：目录内不属于本次结果的头像文件（退群者、下载失败者的旧文件、残留 .tmp）
  const keep = new Set(result.files.values());
  for (const name of readdirSync(opts.dir)) {
    const isAvatar = AVATAR_FILE_RE.test(name);
    const isTmp = name.endsWith(".tmp");
    if ((isAvatar && !keep.has(name)) || isTmp) {
      rmSync(join(opts.dir, name));
      result.stats.pruned++;
    }
  }
  for (const wxid of Object.keys(cache)) {
    if (!result.files.has(wxid)) delete cache[wxid];
  }

  writeFileSync(opts.cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  return result;
}
