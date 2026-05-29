import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored third-party asset (pdfjs worker copied in by scripts/copy-pdf-worker.mjs).
    "public/**",
    // Node-side code, not the Next/React app: Electron main/preload (CommonJS)
    // and build scripts. The browser/React rules here don't apply to them.
    "electron/**",
    "scripts/**",
  ]),
]);

export default eslintConfig;
