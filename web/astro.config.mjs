// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  // 纯静态输出，直接上传 CF Pages；数据在构建期读取，无运行时请求
  output: "static",
  build: { format: "file" },
  devToolbar: { enabled: false },
});
