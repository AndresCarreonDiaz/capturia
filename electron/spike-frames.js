// M7a spike driver: prove offscreen-Electron -> IOSurface at 1080p30.
//
// Boots a hidden offscreen BrowserWindow (GPU shared-texture mode) on the
// studio's Program Output page, feeds every painted frame's IOSurface into the
// native capturia-frames addon (which copies it into an owned IOSurface ring,
// exactly what the future CMIO camera extension sink will consume), snapshots
// PNGs for visual verification, and prints a JSON report with the spike gates:
//   (a) getUserMedia webcam renders inside the offscreen page (non-blank frames)
//   (b) sustained ~30fps paint cadence at 1920x1080
//   (c) sane pixels (BGRA, full size; eyeball the PNGs for compositing)
//
// Run (dev server must be up):   npx electron electron/spike-frames.js
// Env knobs:
//   CAPTURIA_FAKE_CAM=1        Chromium fake camera (no TCC prompt; CI-safe)
//   CAPTURIA_SPIKE_URL         default http://localhost:3000/studio?out=1
//   CAPTURIA_SPIKE_SECONDS     default 20
//   CAPTURIA_SPIKE_FPS         default 30
//   CAPTURIA_SPIKE_OUT         default .spike-out/
//   CAPTURIA_SINK=1            M7b end-to-end: also feed the frames into the
//                              installed "Capturia" camera extension's sink at
//                              a fixed 30fps cadence (repeat-last-frame). Then
//                              open Zoom/Photo Booth and select "Capturia".

const { app, BrowserWindow, session } = require("electron");
const path = require("path");
const fs = require("fs");

const addon = require(path.join(
  __dirname,
  "..",
  "native",
  "capturia-frames",
  "build",
  "Release",
  "capturia_frames.node"
));

const URL = process.env.CAPTURIA_SPIKE_URL || "http://localhost:3000/studio?out=1";
const SECONDS = Number(process.env.CAPTURIA_SPIKE_SECONDS || 20);
const FPS = Number(process.env.CAPTURIA_SPIKE_FPS || 30);
const OUT_DIR =
  process.env.CAPTURIA_SPIKE_OUT || path.join(__dirname, "..", ".spike-out");
const WIDTH = 1920;
const HEIGHT = 1080;

if (process.env.CAPTURIA_FAKE_CAM === "1") {
  // fps=30 matters: the fake device defaults to 20fps, and since offscreen
  // paint is damage-driven the paint rate follows the video rate; real webcams
  // deliver 30.
  app.commandLine.appendSwitch("use-fake-device-for-media-stream", "fps=30");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

app.whenReady().then(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  addon.init(WIDTH, HEIGHT);

  // Same media auto-grant as electron/main.js: the offscreen page calls
  // getUserMedia for the webcam layer.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "media")
  );

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: {
      offscreen: { useSharedTexture: true },
    },
  });
  win.webContents.setFrameRate(FPS);

  const perSecond = new Map(); // wall-clock second -> paints
  let texturePaints = 0;
  let softwarePaints = 0;
  let pushErrors = 0;
  let firstPaintAt = 0;
  const startedAt = Date.now();
  const baselineCpu = app.getAppMetrics(); // primes percentCPUUsage sampling

  win.webContents.on("paint", (event) => {
    const tex = event.texture;
    if (!tex) {
      softwarePaints++;
      return;
    }
    try {
      const handle = tex.textureInfo.handle.ioSurface;
      if (handle) {
        addon.pushFrame(handle);
        texturePaints++;
        if (!firstPaintAt) firstPaintAt = Date.now();
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        perSecond.set(sec, (perSecond.get(sec) || 0) + 1);
      }
    } catch (err) {
      pushErrors++;
      if (pushErrors <= 3) console.error("pushFrame failed:", err);
    } finally {
      tex.release();
    }
  });

  win.webContents.on(
    "did-fail-load",
    (_e, code, desc) => {
      console.error(JSON.stringify({ fatal: `page failed to load: ${code} ${desc}` }));
      app.exit(1);
    }
  );

  win.loadURL(URL);

  // M7b: pump the freshest ring frame into the extension's sink stream on a
  // fixed camera cadence, independent of paint (paint fills the ring, the
  // pump re-sends the last frame when nothing new painted).
  let sinkConnected = false;
  let pumpTimer = null;
  if (process.env.CAPTURIA_SINK === "1") {
    sinkConnected = addon.connectSink("Capturia");
    console.error(
      sinkConnected
        ? "sink: connected to the Capturia camera extension"
        : "sink: Capturia device not found (extension not installed/approved?)"
    );
    if (sinkConnected) {
      pumpTimer = setInterval(() => addon.pumpFrame(), Math.round(1000 / FPS));
    }
  }

  // Snapshots spread across the run so warm-up and steady state both land.
  for (const at of [5, 10, 15]) {
    if (at < SECONDS) {
      setTimeout(() => {
        addon.snapshot(path.join(OUT_DIR, `frame-${at}s.png`));
      }, at * 1000);
    }
  }

  setTimeout(() => {
    if (pumpTimer) clearInterval(pumpTimer);
    addon.snapshot(path.join(OUT_DIR, "frame-final.png"));
    const stats = addon.stats();
    const sink = addon.sinkStats();
    if (sinkConnected) addon.disconnectSink();

    // Steady-state fps: ignore the first 3 warm-up seconds and the tail second.
    const steady = [];
    for (const [sec, n] of perSecond) {
      if (sec >= 3 && sec < SECONDS - 1) steady.push(n);
    }
    steady.sort((a, b) => a - b);
    const fpsMin = steady[0] || 0;
    const fpsMedian = steady[Math.floor(steady.length / 2)] || 0;
    const fpsAvg = steady.length
      ? steady.reduce((a, b) => a + b, 0) / steady.length
      : 0;

    const metrics = app.getAppMetrics();
    const cpu = metrics.map((m) => ({
      type: m.type,
      pct: Number(m.cpu.percentCPUUsage.toFixed(1)),
    }));
    void baselineCpu;

    const gates = {
      a_nonBlankFrames:
        stats.frames > 0 && stats.blankFrames / stats.frames < 0.2,
      b_sustainedFps: fpsMin >= FPS - 4 && fpsMedian >= FPS - 2,
      c_fullSizeBgra:
        stats.lastWidth === WIDTH &&
        stats.lastHeight === HEIGHT &&
        stats.lastPixelFormat === "BGRA",
    };

    const report = {
      url: URL,
      seconds: SECONDS,
      requestedFps: FPS,
      texturePaints,
      softwarePaints,
      pushErrors,
      timeToFirstPaintMs: firstPaintAt ? firstPaintAt - startedAt : null,
      fps: { min: fpsMin, median: fpsMedian, avg: Number(fpsAvg.toFixed(1)) },
      perSecond: Object.fromEntries(perSecond),
      addon: stats,
      sink: { requested: process.env.CAPTURIA_SINK === "1", connected: sinkConnected, ...sink },
      cpuPercentByProcess: cpu,
      gates,
      pass: gates.a_nonBlankFrames && gates.b_sustainedFps && gates.c_fullSizeBgra,
    };
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.pass ? 0 : 1);
  }, SECONDS * 1000);
});
