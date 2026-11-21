import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // Migration SQL is read at runtime by the demo bootstrap, so it must ship with the server bundle.
  outputFileTracingIncludes: { "/**": ["./drizzle/**/*"] },
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.16.*.*"],
};

export default nextConfig;
