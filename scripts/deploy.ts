#!/usr/bin/env node
/**
 * M5 部署脚本：构建 + 隐私复核 + wrangler pages deploy。
 *
 * 防线（AGENTS.md「开源 vs 闭源」「Web 层」）：
 *   1. members.json 必须是 public 模式——private 产物含 wxid/alias/remark，拒绝上传
 *   2. 构建后复核 web/dist：不允许任何 .json；HTML 中 PUBLIC_STRIPPED_FIELDS 相关
 *      字样（wxid / 微信号 / 备注）0 次出现
 *   3. 通过后才交给 wrangler（functions/ 口令门随部署上传；SITE_PASSWORD 未配置时站点 503 fail closed）
 *
 * 用法：pnpm web:deploy
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const PROJECT_NAME = "wegroup-members";
const DIST = resolve("web/dist");
const DATA = resolve("web/src/data/members.json");

function fail(msg: string): never {
  console.error(`[deploy] ✖ ${msg}`);
  process.exit(1);
}
const log = (...xs: unknown[]): void => console.error("[deploy]", ...xs);

// ---------- 1. 数据必须是 public 模式 ----------

if (!existsSync(DATA)) fail(`缺少 ${DATA}，先跑 pnpm collect`);
const data = JSON.parse(readFileSync(DATA, "utf8")) as {
  config?: { mode?: string; collectedAt?: string };
};
if (data.config?.mode !== "public") {
  fail(`members.json 是 ${data.config?.mode ?? "未知"} 模式，拒绝部署；先跑 pnpm collect 重新采集`);
}
log(`数据：public 模式，采集于 ${data.config.collectedAt}`);

// ---------- 2. 构建 ----------

log("构建 web/dist …");
execFileSync("pnpm", ["web:build"], { stdio: "inherit" });

// ---------- 3. 隐私复核 ----------

const jsonLeaks = execFileSync("find", [DIST, "-name", "*.json"], { encoding: "utf8" }).trim();
if (jsonLeaks) fail(`dist 中出现 .json 文件：\n${jsonLeaks}`);

const html = readFileSync(join(DIST, "index.html"), "utf8");
for (const word of ["wxid", "微信号", "备注"]) {
  if (html.includes(word)) fail(`dist/index.html 含 "${word}"，疑似 private 产物混入`);
}
log("隐私复核通过：无 .json，无 wxid/微信号/备注 字样");

// ---------- 4. 上传 ----------

// 从仓库根运行：wrangler 会顺带打包根目录的 functions/（口令门）
execFileSync(
  "pnpm",
  ["exec", "wrangler", "pages", "deploy", DIST, "--project-name", PROJECT_NAME, "--branch", "main"],
  { stdio: "inherit" },
);
log("✅ 部署完成");
