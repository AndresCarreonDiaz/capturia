// Vendors the pdfjs worker into public/ so the browser can load it from a
// stable, same-origin URL ("/pdf.worker.min.mjs") without bundler worker
// resolution or CSP friction. Runs on predev/prebuild/postinstall, so it stays
// in sync with the installed pdfjs-dist version automatically.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const destDir = join(root, "public");
const dest = join(destDir, "pdf.worker.min.mjs");

try {
  if (!existsSync(src)) {
    console.warn("[copy-pdf-worker] pdfjs-dist worker not found; skipping (deck PDF import will be unavailable).");
    process.exit(0);
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log("[copy-pdf-worker] copied pdf.worker.min.mjs -> public/");
} catch (err) {
  console.warn("[copy-pdf-worker] failed:", err?.message ?? err);
  // Non-fatal: don't block dev/build over the deck worker.
  process.exit(0);
}
