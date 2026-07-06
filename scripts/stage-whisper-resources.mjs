// Stages nodejs-whisper for packaging. The packaged app cannot run it from
// the asar (it chdirs and execs cwd-relative paths inside its package dir),
// and a bare extraResources copy of the package alone cannot resolve its own
// dependencies (Node walks real paths upward from Contents/Resources, where
// no node_modules exists). So this script builds a SELF-CONTAINED copy:
//
//   .whisper-stage/nodejs-whisper/            the package, incl. cpp/ and any
//                                             provisioned whisper-cli + model
//   .whisper-stage/nodejs-whisper/node_modules/<dep>   full transitive closure
//
// electron-builder ships that directory as Contents/Resources/nodejs-whisper
// (see extraResources in electron-builder.yml) and electron/whisper.js
// requires it from process.resourcesPath when packaged. Runs from pack:mac.

import { cpSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(root, ".whisper-stage");
const stagePkgDir = join(stageDir, "nodejs-whisper");

// Resolve a package's real directory relative to whoever depends on it, so
// npm's nesting/dedup layout is honored exactly as Node would at runtime.
function pkgDir(name, fromDir) {
  const req = createRequire(join(fromDir, "package.json"));
  return dirname(req.resolve(`${name}/package.json`));
}

// Transitive production-dependency closure, name -> source directory.
const closure = new Map();
function walk(name, fromDir) {
  if (closure.has(name)) return;
  const dir = pkgDir(name, fromDir);
  closure.set(name, dir);
  const pkg = createRequire(join(dir, "package.json"))("./package.json");
  for (const dep of Object.keys(pkg.dependencies || {})) walk(dep, dir);
}

const whisperDir = pkgDir("nodejs-whisper", root);
const whisperPkg = createRequire(join(whisperDir, "package.json"))("./package.json");
for (const dep of Object.keys(whisperPkg.dependencies || {})) walk(dep, whisperDir);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stagePkgDir, { recursive: true });
// The package itself, including cpp/whisper.cpp (and, when provisioned, the
// compiled whisper-cli and ggml model that make packaged transcription work).
cpSync(whisperDir, stagePkgDir, { recursive: true });
for (const [name, dir] of closure) {
  cpSync(dir, join(stagePkgDir, "node_modules", name), { recursive: true });
}
console.log(
  `[stage-whisper-resources] staged nodejs-whisper + ${closure.size} deps -> ${stagePkgDir}`
);
