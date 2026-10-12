import type { NextConfig } from "next";
import os from "node:os";

// Dev-server origin allow-list. Next blocks its dev resources (HMR, client
// chunks) for any host other than "localhost" and the ones listed here, which
// hangs the app at "Loading Digital Twin viewer…" when it is opened through
// 127.0.0.1, the LAN IP or the Tailscale IP (the mobile app's WebView does
// exactly that). Every address this machine owns is this machine, so they are
// all allowed; extra hostnames come from AGROTWIN_DEV_ORIGINS (comma-separated).
const localAddresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
  .map((iface) => iface!.address);
const extraOrigins = (process.env.AGROTWIN_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "127.0.0.1",
    ...localAddresses,
    "agency.cenedypalma.com",
    "bayazid.cenedypalma.com",
    ...extraOrigins,
  ],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.AGROTWIN_API_URL ?? "http://127.0.0.1:8000"}/api/:path*`,
      },
    ];
  },
  experimental: {
    // Drone frames are uploaded through this proxy in 20-file batches
    // (~10 MB per DJI JPG). Next buffers proxied bodies and silently truncates
    // them at 10 MB by default, which breaks multipart uploads.
    proxyClientMaxBodySize: "1gb",
    proxyTimeout: 600_000,
    // Production builds hung the viewer at "Initializing viewer…": Cesium
    // embeds its SPZ (splat) decoder as a template literal holding `\x000`,
    // and the minifier rewrites that to `\00`, an octal escape that is a
    // SyntaxError in template strings, so the Cesium chunk never loads. Dev
    // builds are not minified; Cesium itself ships pre-minified anyway.
    turbopackMinify: false,
  },
};

export default nextConfig;
