import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Info: (20261118 - Luphia) 伺服器端 PDF 使用本機 Chrome，playwright-core 不打包
  // Info: (20261120 - Luphia) PDF 壓縮分割：sharp (原生模組) 與 pdf-lib 不打包
  serverExternalPackages: ["playwright-core", "sharp", "pdf-lib"],
};

export default nextConfig;
