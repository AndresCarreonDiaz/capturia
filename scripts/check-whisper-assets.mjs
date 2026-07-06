// Pack-time visibility for the whisper provisioning state. The packaged app
// ships node_modules/nodejs-whisper as an extraResource; whether transcription
// works out of the box depends on what that directory holds when
// electron-builder copies it: the compiled whisper-cli binary and the ggml
// model, both produced by `npx nodejs-whisper download`. Missing pieces do
// not fail the build (the app degrades to a clear runtime error and the
// agent loop works without local STT), but packing blind was how it shipped
// broken before, so say it loudly.

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

if (missing.length > 0) {
  console.warn(
    `[check-whisper-assets] WARNING: packaging without ${missing.join(" or ")}. ` +
      "The packaged app's voice transcription will surface a provisioning error " +
      "until `npx nodejs-whisper download` runs before packing. " +
      "A future SIGNED build must ship these embedded: downloading after install " +
      "would write into the bundle and break its signature."
  );
} else {
  console.log(`[check-whisper-assets] whisper-cli + ${models.join(", ")} present`);
}
