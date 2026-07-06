// electron-builder afterPack hook. Two jobs today, one more when Apple
// activates (embedding + signing the CMIO camera extension, see the M7b
// issue):
//
// 1. Copy the staged self-contained nodejs-whisper into Contents/Resources.
//    This cannot ride extraResources: electron-builder's default file-set
//    excludes silently strip node_modules directories from the copy, and the
//    staged package NEEDS its nested node_modules to resolve shelljs & co.
// 2. Nothing else yet; signing runs through electron-builder's own config
//    (identity/entitlements in electron-builder.yml) once an identity exists.

import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export default async function afterPack(context) {
  const stage = join(root, ".whisper-stage", "nodejs-whisper");
  if (!existsSync(stage)) {
    throw new Error(
      "afterPack: .whisper-stage missing; run node scripts/stage-whisper-resources.mjs (pack:mac does this)."
    );
  }
  const resources = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources"
  );
  const dest = join(resources, "nodejs-whisper");
  rmSync(dest, { recursive: true, force: true });
  cpSync(stage, dest, { recursive: true });
  console.log(`  • afterPack copied self-contained nodejs-whisper -> ${dest}`);
}
