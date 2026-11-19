import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Info: (20261118 - Luphia) 伺服器端 PDF 使用本機 Chrome，playwright-core 不打包
  serverExternalPackages: ["playwright-core"],
};

export default nextConfig;
