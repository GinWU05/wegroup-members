/**
 * 口令门：Cloudflare Pages Functions 中间件，拦截站点全部路径（含头像等静态资源）。
 * 硬规则（AGENTS.md 决策 2026-09-06）：部署必须带 CF Access 或口令；选口令是因为
 * 访客是微信群成员，没有统一邮箱域可做 Access 策略，共享口令 + 表单登录对微信内置
 * 浏览器最友好（Basic Auth 弹窗在部分 WebView 里不可用）。
 *
 * 机制：
 *   - 口令存 Pages Secret `SITE_PASSWORD`（wrangler pages secret put，不进 git）
 *   - 通过后发 HttpOnly Cookie，值为 HMAC-SHA256(口令, 固定消息)——无状态、换口令即全员失效
 *   - 未配置 SITE_PASSWORD 时 fail closed（503），绝不裸奔
 *   - 登录页为通用文案，不含任何群特定信息（本文件入库）
 */

interface Env {
  SITE_PASSWORD?: string;
}

/** Pages Functions 上下文（只声明用到的成员，避免引入 @cloudflare/workers-types） */
interface PagesContext {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}

const COOKIE_NAME = "wg_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 天
const TOKEN_MESSAGE = "wegroup-members auth v1"; // 换值可强制全员重新登录

async function tokenOf(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(TOKEN_MESSAGE));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常数时间比较，避免逐字符早退的时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValueOf(header: string | null, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

function loginPage(wrongPassword: boolean): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>需要口令</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1a1f26;
  }
  form {
    display: grid; gap: 0.75rem; width: min(320px, calc(100vw - 3rem));
    padding: 2rem 1.75rem; background: #fff; border: 1px solid #e2e5ea; border-radius: 16px;
  }
  h1 { margin: 0; font-size: 1.15rem; }
  p { margin: 0; font-size: 0.85rem; color: #6b7280; }
  .err { color: #b91c1c; }
  input {
    padding: 0.6rem 0.8rem; font-size: 1rem; border: 1px solid #cbd2dc; border-radius: 10px;
    background: inherit; color: inherit;
  }
  button {
    padding: 0.6rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 10px;
    background: #2563eb; color: #fff; cursor: pointer;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1216; color: #e5e9ef; }
    form { background: #171c23; border-color: #2a323d; }
    input { border-color: #3a4450; }
  }
</style>
</head>
<body>
<form method="post">
  <h1>此站点需要口令</h1>
  <p>请输入访问口令。没有口令？向分享此链接给你的人索取。</p>
  ${wrongPassword ? '<p class="err">口令不正确，请重试。</p>' : ""}
  <input type="password" name="password" placeholder="访问口令" autocomplete="current-password" autofocus required />
  <button>进入</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function onRequest(ctx: PagesContext): Promise<Response> {
  const password = ctx.env.SITE_PASSWORD ?? "";
  // fail closed：口令未配置时拒绝服务，避免误把无门版本上线
  if (!password) return new Response("站点未配置访问口令（SITE_PASSWORD）", { status: 503 });

  const expected = await tokenOf(password);
  const got = cookieValueOf(ctx.request.headers.get("cookie"), COOKIE_NAME);
  if (safeEqual(got, expected)) return ctx.next();

  if (ctx.request.method === "POST") {
    const form = await ctx.request.formData().catch(() => null);
    const attempt = form?.get("password");
    // 用 HMAC 结果比较而非明文比较，顺带把长度差异也抹平
    if (typeof attempt === "string" && safeEqual(await tokenOf(attempt), expected)) {
      const url = new URL(ctx.request.url);
      return new Response(null, {
        status: 303, // 重定向回 GET，避免刷新重复提交
        headers: {
          location: url.pathname + url.search,
          "set-cookie": `${COOKIE_NAME}=${expected}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }
    return loginPage(true);
  }
  return loginPage(false);
}
