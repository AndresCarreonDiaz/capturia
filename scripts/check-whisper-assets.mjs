// Pack-time visibility for the whisper provisioning state. The packaged app
// ships node_modules/nodejs-whisper as an extraResource; whether transcription
// works out of the box depends on what that directory holds when
// electron-builder copies it: the compiled whisper-cli binary and the ggml
// model, both produced by `npx nodejs-whisper download`. In the default
// (dev-loop) mode missing pieces do not fail the build (the app degrades to a
// clear runtime error and the agent loop works without local STT), but
// packing blind was how it shipped broken before, so say it loudly. With
// --strict (the dist:mac release path) the same gap FAILS the build: a
// release artifact cannot download the model after install, because that
// write into the sealed bundle would break its signature.

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cppDir = join(root, "node_modules", "nodejs-whisper", "cpp", "whisper.cpp");
const cli = join(cppDir, "build", "bin", "whisper-cli");
const modelsDir = join(cppDir, "models");
const models = existsSync(modelsDir)
  ? readdirSync(modelsDir).filter((f) => f.startsWith("ggml-") && f.endsWith(".bin"))
  : [];

const missing = [];
if (!existsSync(cli)) missing.push("whisper-cli binary");
if (models.length === 0) missing.push("ggml model");

const strict = process.argv.includes("--strict");

if (missing.length > 0) {
  if (strict) {
    console.error(
      `[check-whisper-assets] FAIL (--strict): cannot build a release without ${missing.join(" or ")}. ` +
        "Run `npx nodejs-whisper download` first; a release artifact must ship whisper " +
        "embedded because a post-install download would write into the sealed bundle " +
        "and break its signature."
    );
    process.exit(1);
  }
  console.warn(
    `[check-whisper-assets] WARNING: packaging without ${missing.join(" or ")}. ` +
      "The packaged app's voice transcription will surface a provisioning error " +
      "until `npx nodejs-whisper download` runs before packing. " +
      "A SIGNED RELEASE build must ship these embedded: downloading after install " +
      "would write into the bundle and break its signature (dist:mac enforces this " +
      "with --strict)."
  );
} else {
  console.log(`[check-whisper-assets] whisper-cli + ${models.join(", ")} present`);
}
