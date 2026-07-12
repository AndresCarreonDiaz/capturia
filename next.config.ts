import type { NextConfig } from "next";

// CAPTURIA_ELECTRON_BUILD=1 switches the build to the static export that the
// Electron shell loads (npm run build:electron). The desktop bundle ships only
// the client pages: the server surface (app/api, app/vote) is relocated out of
// the build by scripts/build-electron-export.mjs, and the CopilotKit runtime
// is hosted by Electron main instead (electron/runtime-server.js).
const isElectronBuild = process.env.CAPTURIA_ELECTRON_BUILD === "1";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@copilotkit/runtime"],
  ...(isElectronBuild && {
    output: "export" as const,
    // This Next version exports straight into distDir (there is no separate
    // out/ folder like classic Next). Pointing it at out/ gives exactly the
    // out/studio.html path electron/main.js loads. NOTE: the export build
    // still writes build internals into .next/ and would leave a stale
    // electron-flavored production build behind; scripts/build-electron-
    // export.mjs defuses that so `next start` fails loudly instead.
    distDir: "out",
    // The exported studio loads from file://, where absolute /_next/ asset
    // URLs have no host to resolve against. Both shipped pages sit at the
    // export root (trailingSlash stays unset so /studio -> out/studio.html,
    // the exact path electron/main.js loads), so a relative prefix resolves.
    assetPrefix: "./",
    images: { unoptimized: true },
    // The desktop bundle ships no analytics: Vercel Web Analytics covers the
    // hosted web surfaces only (the anonymous beacon covers the app, see
    // docs/telemetry.md), and on file:// the insights script has nothing to
    // talk to. Aliasing the package to a no-op stub keeps its code out of
    // the export entirely; the root layout additionally skips the mount.
    turbopack: {
      resolveAlias: {
        "@vercel/analytics": "./lib/vercel-analytics-noop.tsx",
        "@vercel/analytics/next": "./lib/vercel-analytics-noop.tsx",
      },
    },
  }),
};

export default nextConfig;
