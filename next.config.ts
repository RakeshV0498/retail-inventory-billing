import type { NextConfig } from "next";

/** Applied to every response. A strict script CSP is intentionally skipped (Next's inline scripts need nonces). */
export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  serverExternalPackages: ["better-sqlite3"],
  // Migration SQL is read at runtime by the demo bootstrap, so it must ship with the server bundle.
  outputFileTracingIncludes: { "/**": ["./drizzle/**/*"] },
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.16.*.*"],
};

export default nextConfig;
