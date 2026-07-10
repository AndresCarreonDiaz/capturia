// The app-lifetime virtual-camera feed (M7b, productized from
// electron/spike-frames.js; docs/m7a-spike.md has the measured numbers).
//
// A hidden offscreen BrowserWindow renders the studio's Program Output page
// (the main window's URL plus ?out=1) in GPU shared-texture mode. Every paint
// hands us an IOSurface, which the native capturia-frames addon copies into
// its owned triple-buffered ring; a fixed 30fps pump then wraps the freshest
// ring frame in a CMSampleBuffer and enqueues it into the "Capturia" CMIO
// camera extension's sink stream (repeat-last-frame, so the camera never
// starves while nothing repaints).
//
// Lifecycle contract with main.js: createCameraFeed() once, start() after
// app.whenReady (skipped in smoke mode), dispose() on will-quit. start/stop
// are also reachable from the tray's Camera toggle and the camera:* IPC.
//
// Failure posture: never crash the shell. Missing native build, extension not
// installed/approved, sink connect refusals, offscreen renderer crashes: all
// land in getState().error plus bounded retries, never exceptions.
//
// The offscreen window deliberately gets NO preload: without window.capturia
// the page behaves like the web studio, so it cannot state:report (which
// would fight the visible window's tray state), never joins the loopback
// runtime, and has no speech bridge (voice only starts on operator action,
// and hotkey sends target the main window alone).

const { BrowserWindow } = require("electron");
const path = require("path");

const {
  CAMERA_DEVICE_NAME,
  CAMERA_WIDTH,
  CAMERA_HEIGHT,
  CAMERA_FPS,
  SINK_CONNECT_DELAYS_MS,
  findCameraDevice,
  programOutputUrl,
  shouldRecreateAfterCrash,
} = require("./gen/camera-feed");

// Lazy addon load: a checkout without the built .node must degrade to an
// "unavailable" camera, not a crashed shell.
let addon;
function loadAddon() {
  if (addon !== undefined) return addon;
  try {
    addon = require(path.join(
      __dirname,
      "..",
      "native",
      "capturia-frames",
      "build",
      "Release",
      "capturia_frames.node"
    ));
  } catch (err) {
    addon = null;
    console.error(
      "Capturia: capturia-frames addon not built (cd native/capturia-frames && npx node-gyp rebuild):",
      err.message
    );
  }
  return addon;
}

// studioUrl: the exact URL the main window loads (dev server or static
// export); ?out=1 is appended here. isAllowedNavigation: main.js's URL
// allowlist, reused so the offscreen window has the same navigation lockdown
// as the visible one. onStateChange fires on lifecycle transitions (connect,
// stop, give-up, crash), NOT once per second, so it is safe to rebuild the
// tray menu from it.
function createCameraFeed({ studioUrl, isAllowedNavigation, onStateChange, log = console }) {
  let win = null;
  let wantRunning = false;
  let disposed = false;
  let sinkConnected = false;
  let connectTimer = null;
  let recreateTimer = null;
  let pumpTimer = null;
  let fpsTimer = null;
  let available = false;
  let error = null;
  // Sink deliveries in the last complete second: the fps the state reports.
  let pumpedThisSecond = 0;
  let lastFps = 0;
  // Paint-side counters, kept for the periodic CAPTURIA_CAMERA_LOG line.
  let paintsThisSecond = 0;
  let lastPaintFps = 0;
  let pushErrors = 0;
  const crashTimes = [];

  function notify() {
    if (typeof onStateChange !== "function") return;
    try {
      onStateChange(getState());
    } catch (err) {
      log.error("[camera] onStateChange threw:", err);
    }
  }

  function getState() {
    const native = loadAddon();
    const sink =
      native && sinkConnected
        ? native.sinkStats()
        : { pumped: 0, droppedQueueFull: 0 };
    return {
      available,
      running: sinkConnected && pumpTimer !== null,
      fps: lastFps,
      pumped: sink.pumped,
      droppedQueueFull: sink.droppedQueueFull,
      error,
    };
  }

  // Paint handler, straight from the proven spike: the IOSurface handle is
  // only valid until texture.release(), and the addon's copy is synchronous,
  // so push-then-release inside the handler is safe.
  function onPaint(event) {
    const tex = event.texture;
    if (!tex) return; // software paint; shared-texture mode should not produce these
    try {
      const native = loadAddon();
      const handle = tex.textureInfo.handle.ioSurface;
      if (native && handle) {
        native.pushFrame(handle);
        paintsThisSecond++;
      }
    } catch (err) {
      pushErrors++;
      if (pushErrors <= 3) log.error("[camera] pushFrame failed:", err);
    } finally {
      tex.release();
    }
  }

  function onRendererGone(_event, details) {
    if (disposed || !wantRunning) return;
    crashTimes.push(Date.now());
    log.warn(
      `[camera] offscreen Program Output renderer gone (${details && details.reason}); recreating`
    );
    destroyWindow();
    if (!shouldRecreateAfterCrash(crashTimes, Date.now())) {
      error = "Program Output crashed repeatedly; camera feed stopped.";
      log.error(`[camera] ${error}`);
      stop({ keepError: true });
      return;
    }
    // While the window is down the pump keeps re-sending the last ring frame,
    // so viewers see a freeze (not black) across the recreate.
    recreateTimer = setTimeout(() => {
      recreateTimer = null;
      if (wantRunning && !disposed) createWindow();
    }, 1000);
  }

  function createWindow() {
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({
      width: CAMERA_WIDTH,
      height: CAMERA_HEIGHT,
      show: false,
      webPreferences: {
        offscreen: { useSharedTexture: true },
        // No preload on purpose; see the module header.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // The whole point is to keep painting while hidden behind a call.
        backgroundThrottling: false,
      },
    });
    win.webContents.setFrameRate(CAMERA_FPS);
    win.webContents.on("paint", onPaint);
    win.webContents.on("render-process-gone", onRendererGone);
    // Same navigation lockdown as the main window: this renderer holds no
    // privileges (no preload), but it can reach the webcam via the session's
    // permission handler, so it must never leave the studio origin.
    win.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // A failed load is survivable (dev server not up yet, for instance): the
    // sink keeps getting whatever the ring last held. Report it and let a
    // manual toggle retry.
    win.webContents.on("did-fail-load", (_event, code, desc) => {
      error = `Program Output failed to load: ${desc || code}`;
      log.warn(`[camera] ${error}`);
      notify();
    });
    win.webContents.on("did-finish-load", () => {
      if (error && error.startsWith("Program Output failed to load")) {
        error = null;
        notify();
      }
    });
    win.loadURL(programOutputUrl(studioUrl));
  }

  function destroyWindow() {
    if (recreateTimer) {
      clearTimeout(recreateTimer);
      recreateTimer = null;
    }
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  function startPump() {
    const native = loadAddon();
    pumpedThisSecond = 0;
    paintsThisSecond = 0;
    lastFps = 0;
    lastPaintFps = 0;
    pumpTimer = setInterval(() => {
      try {
        if (native.pumpFrame()) pumpedThisSecond++;
      } catch (err) {
        pushErrors++;
        if (pushErrors <= 3) log.error("[camera] pumpFrame failed:", err);
      }
    }, Math.round(1000 / CAMERA_FPS));
    let seconds = 0;
    fpsTimer = setInterval(() => {
      lastFps = pumpedThisSecond;
      lastPaintFps = paintsThisSecond;
      pumpedThisSecond = 0;
      paintsThisSecond = 0;
      seconds++;
      if (process.env.CAPTURIA_CAMERA_LOG === "1" && seconds % 5 === 0) {
        const sink = native.sinkStats();
        log.log(
          `[camera] fps=${lastFps} paints=${lastPaintFps} pumped=${sink.pumped} droppedQueueFull=${sink.droppedQueueFull}`
        );
      }
    }, 1000);
  }

  function stopPump() {
    if (pumpTimer) clearInterval(pumpTimer);
    if (fpsTimer) clearInterval(fpsTimer);
    pumpTimer = null;
    fpsTimer = null;
    lastFps = 0;
    lastPaintFps = 0;
  }

  // One discovery + connect attempt; walks SINK_CONNECT_DELAYS_MS and then
  // gives up with a state the tray/renderer can show. Discovery is inside the
  // loop on purpose: at cold login the extension enumerates late, and right
  // after approval the first connect can be refused.
  function attemptConnect(attempt) {
    connectTimer = null;
    if (disposed || !wantRunning) return;
    const native = loadAddon();
    const device = findCameraDevice(native.listDevices());
    available = Boolean(device);
    let connected = false;
    if (device) {
      try {
        connected = native.connectSink(CAMERA_DEVICE_NAME);
      } catch (err) {
        log.error("[camera] connectSink threw:", err);
      }
    }
    if (connected) {
      sinkConnected = true;
      error = null;
      createWindow();
      startPump();
      log.log(`[camera] connected to the ${CAMERA_DEVICE_NAME} camera sink; feeding Program Output`);
      notify();
      return;
    }
    if (attempt >= SINK_CONNECT_DELAYS_MS.length) {
      error = available
        ? "Could not connect to the Capturia camera sink."
        : "Capturia camera extension not found (install and approve it in System Settings).";
      log.warn(`[camera] giving up after ${attempt + 1} attempts: ${error}`);
      wantRunning = false;
      notify();
      return;
    }
    connectTimer = setTimeout(
      () => attemptConnect(attempt + 1),
      SINK_CONNECT_DELAYS_MS[attempt]
    );
  }

  // Begin (or retry) feeding the camera. Idempotent while already running or
  // mid-connect. Returns the state snapshot so IPC callers get an immediate
  // answer.
  function start() {
    if (disposed) return getState();
    if (wantRunning && (sinkConnected || connectTimer)) return getState();
    const native = loadAddon();
    if (!native) {
      available = false;
      error = "Native camera module not built.";
      notify();
      return getState();
    }
    wantRunning = true;
    error = null;
    // (Re)allocate the owned IOSurface ring; also resets the addon counters.
    native.init(CAMERA_WIDTH, CAMERA_HEIGHT);
    attemptConnect(0);
    return getState();
  }

  // Stop feeding and release everything (sink stream, pump, offscreen
  // window). keepError preserves a fatal reason (crash loop) for the UI;
  // an operator-requested stop clears it.
  function stop({ keepError = false } = {}) {
    wantRunning = false;
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    stopPump();
    if (sinkConnected) {
      const native = loadAddon();
      try {
        if (native) native.disconnectSink();
      } catch (err) {
        log.error("[camera] disconnectSink failed:", err);
      }
      sinkConnected = false;
      log.log("[camera] disconnected from the camera sink");
    }
    destroyWindow();
    if (!keepError) error = null;
    notify();
    return getState();
  }

  // Final teardown on app quit; the feed cannot be restarted afterwards.
  function dispose() {
    if (disposed) return;
    stop({ keepError: true });
    disposed = true;
  }

  return { start, stop, getState, dispose };
}

module.exports = { createCameraFeed };
