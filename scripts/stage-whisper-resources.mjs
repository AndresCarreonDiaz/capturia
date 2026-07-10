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
// (via the afterPack hook, see electron-builder.yml) and electron/whisper.js
// requires it from process.resourcesPath when packaged. Runs from pack:mac.
//
// The staged copy is also SLIMMED and made RELOCATABLE:
//
//   - cpp/whisper.cpp/build keeps only what runtime needs: bin/whisper-cli,
//     the dylibs it links, and metal shader files. The CMake intermediates
//     (500+ object files) are dead weight the signing pass would otherwise
//     timestamp-codesign ONE BY ONE, which turns a signed pack:mac from
//     minutes into the better part of an hour.
//   - whisper-cli is provisioned by nodejs-whisper's cmake build with
//     ABSOLUTE LC_RPATHs into this checkout's node_modules, so the packaged
//     copy would only ever find its dylibs on the machine that packed it.
//     Relative @executable_path rpaths are added (and the binary re-signed
//     ad-hoc, since install_name_tool invalidates the signature and an
//     unsigned pack must stay runnable on arm64).

import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { platform } from "node:os";

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
// verbatimSymlinks keeps the build tree's RELATIVE symlinks (libwhisper.dylib
// chain) relative; the default rewrites them into absolute paths pointing at
// this checkout, which only ever resolve on the machine that packed.
cpSync(whisperDir, stagePkgDir, { recursive: true, verbatimSymlinks: true });
for (const [name, dir] of closure) {
  cpSync(dir, join(stagePkgDir, "node_modules", name), {
    recursive: true,
    verbatimSymlinks: true,
  });
}

// Slim the cmake build tree: keep bin/whisper-cli, every dylib (whisper-cli
// links libwhisper + libggml* via rpath), and metal shader files; drop the
// object files, static libs, cmake state, and the test/bench binaries.
const buildDir = join(stagePkgDir, "cpp", "whisper.cpp", "build");
let pruned = 0;
function slim(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    // lstat: a symlink is judged by its own name, never followed (its target
    // may be gone already, and the dylib chain must survive as links).
    if (lstatSync(p).isDirectory()) {
      slim(p);
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
      continue;
    }
    const keep =
      relative(buildDir, p) === join("bin", "whisper-cli") ||
      /\.(dylib|metal|metallib)$/.test(entry);
    if (!keep) {
      rmSync(p);
      pruned++;
    }
  }
}
if (existsSync(buildDir)) slim(buildDir);

// Make the provisioned whisper-cli find its dylibs relative to itself instead
// of through the absolute build-machine rpaths cmake bakes in. The absolute
// ones are DELETED (not just outranked) so a local run of the staged binary
// proves the relative resolution the packaged app will rely on elsewhere.
const cli = join(buildDir, "bin", "whisper-cli");
if (platform() === "darwin" && existsSync(cli)) {
  const load = execFileSync("otool", ["-l", cli], { encoding: "utf8" });
  const absolute = [...load.matchAll(/^\s*path (\/\S+) \(offset/gm)].map((m) => m[1]);
  const args = [
    ...absolute.flatMap((p) => ["-delete_rpath", p]),
    ...["../src", "../ggml/src", "../ggml/src/ggml-blas", "../ggml/src/ggml-metal"].flatMap(
      (p) => ["-add_rpath", `@executable_path/${p}`]
    ),
  ];
  execFileSync("install_name_tool", [...args, cli]);
  // install_name_tool invalidated the signature; restore an ad-hoc one so
  // unsigned packs stay launchable (signed packs re-sign it anyway).
  execFileSync("codesign", ["--force", "--sign", "-", cli]);
}

console.log(
  `[stage-whisper-resources] staged nodejs-whisper + ${closure.size} deps (pruned ${pruned} build files) -> ${stagePkgDir}`
);
