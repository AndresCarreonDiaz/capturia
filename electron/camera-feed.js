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
// Ordering matters: the extension suppresses its animated splash the moment
// the sink stream starts, so the sink is connected only AFTER the page loads
// successfully AND paints (a failed load also paints, as Chromium's error
// page, so neither gate alone proves real content). Until then, and again
// whenever a persistent load failure releases the sink, viewers see the
// splash, never a black frame or a painted error page.
//
// Lifecycle contract with main.js: createCameraFeed() once, start() after
// app.whenReady (skipped in smoke mode), dispose() on will-quit. toggle()
// backs the tray item and acts on intent (stop while connecting OR running);
// start/stop are also reachable from the camera:* IPC.
//
// Failure posture: never crash the shell. Missing native build, extension not
// installed/approved, sink connect refusals, page load failures, offscreen
// renderer crashes, a hijacked sink client: all land in getState().error or
// a state flag plus bounded retries (loads keep retrying in the background
// while wanted), never exceptions.
//
// Privacy posture (issue #38): the offscreen page captures the PHYSICAL
// webcam, and a green camera LED with no visible app reads as spyware. The
// extension publishes how many call apps are consuming its source stream
// (custom 'ccon' device property; addon sinkConsumers()); after
// WEBCAM_IDLE_AFTER_SECONDS with zero consumers the page is told (via
// executeJavaScript, since it has no preload) to release getUserMedia and
// render a branded standing-by card the pump keeps delivering, and a
// WEBCAM_RESUME_POLL_MS poll brings live video back the moment a call app
// attaches. Unknown consumer counts (an extension predating the property)
// never pause: fail-safe live. This deliberately does NOT reuse the
// queue-full stall signal below, which means "the extension stopped
// draining OUR sink" and triggers a reconnect; overloading it would make
// "nobody is watching" and "the sink is broken" indistinguishable.
//
// The offscreen window deliberately gets NO preload: without window.capturia
// the page behaves like the web studio, so it cannot state:report (which
// would fight the visible window's tray state), never joins the loopback
// runtime, and has no speech bridge (voice only starts on operator action,
// and hotkey sends target the main window alone). The Control Room's live
// overlays still reach this page: ?out=1 marks it a mirror RECEIVER, and the
// visible studio broadcasts its state over a same-origin BroadcastChannel
// (lib/mirror.ts + hooks/useStudioMirror.ts), no preload required.

const { app, BrowserWindow } = require("electron");
const path = require("path");

const {
  CAMERA_DEVICE_NAME,
  CAMERA_WIDTH,
  CAMERA_HEIGHT,
  CAMERA_FPS,
  SINK_CONNECT_DELAYS_MS,
  LOAD_RETRY_MAX_DELAY_MS,
  FROZEN_AFTER_SECONDS,
  SINK_STALL_SECONDS,
  WEBCAM_IDLE_BOOT,
  WEBCAM_RESUME_POLL_MS,
  findCameraDevice,
  programOutputUrl,
  reduceWebcamIdleSecond,
  shouldRecreateAfterCrash,
  sinkStalledSecond,
  cameraToggleAction,
  webcamControlScript,
} = require("./gen/camera-feed");

// Where the addon lives per layout. Dev: the node-gyp output inside the
// checkout. Packaged: Contents/Resources/capturia_frames.node, placed there
// by scripts/after-pack.mjs (a .node cannot load from inside the asar, so it
// ships as a real file next to the other native pieces).
const ADDON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "capturia_frames.node")
  : path.join(__dirname, "..", "native", "capturia-frames", "build", "Release", "capturia_frames.node");

// Lazy addon load. A failed load is retried only when retryAfterFailure is
// set (start(), a user intent), so cheap callers like getState() never spam
// require attempts, but fixing the environment (building the addon, moving
// the packaged app) and clicking the toggle CAN recover without a relaunch.
let addon; // undefined = never tried, null = last attempt failed
function loadAddon(retryAfterFailure = false) {
  if (addon) return addon;
  if (addon === null && !retryAfterFailure) return null;
  try {
    addon = require(ADDON_PATH);
  } catch (err) {
    addon = null;
    // Keep the dev message stable: scripts/e2e-desktop-camera.mjs matches
    // "capturia-frames addon not built" to classify its environment skip.
    console.error(
      app.isPackaged
        ? `Capturia: capturia-frames addon missing from the packaged app (${ADDON_PATH}); repack with npm run pack:mac:`
        : "Capturia: capturia-frames addon not built (cd native/capturia-frames && npx node-gyp rebuild):",
      err.message
    );
  }
  return addon;
}

// studioUrl: the exact URL the main window loads (dev server or static
// export); ?out=1 is appended here. isAllowedNavigation: main.js's URL
// allowlist, reused so the offscreen window has the same navigation lockdown
// as the visible one. onStateChange fires on lifecycle transitions (connect,
// stop, load failure, frozen flips, give-up), NOT once per second, so it is
// safe to rebuild the tray menu from it.
function createCameraFeed({ studioUrl, isAllowedNavigation, onStateChange, log = console }) {
  let win = null;
  let wantRunning = false;
  let disposed = false;
  let sinkConnected = false;
  let connectTimer = null;
  let loadTimer = null;
  let loadAttempt = 0;
  let recreateTimer = null;
  let pumpTimer = null;
  let fpsTimer = null;
  let available = false;
  let error = null;
  // Per-load-attempt gates for bringing the sink up. BOTH must hold before
  // connecting: a successful main-frame load (did-finish-load with no
  // did-fail-load this attempt; Chromium renders and PAINTS an error page
  // after a failed load, so paints alone prove nothing) and at least one
  // paint (so the ring holds real pixels, never an empty black frame).
  let sawPaintSinceLoad = false;
  let loadFailedThisAttempt = false;
  let pageReady = false;
  // Sink deliveries and paints in the last complete second.
  let pumpedThisSecond = 0;
  let lastFps = 0;
  let paintsThisSecond = 0;
  let lastPaintFps = 0;
  let lastPaintAt = null;
  // Health counters evaluated once per second while the pump runs.
  let zeroPaintSeconds = 0;
  let frozen = false;
  let stallSeconds = 0;
  let pushErrors = 0;
  const crashTimes = [];
  // Webcam idle machine (issue #38): while the pump runs, the extension's
  // consumer count ('ccon' device property, read through the addon) says
  // whether ANY call app is consuming the Capturia camera. After
  // WEBCAM_IDLE_AFTER_SECONDS without one, the offscreen page is told to
  // release its physical-webcam capture (green LED off) and it renders a
  // branded "standing by" card the pump keeps delivering; a fast poll
  // (WEBCAM_RESUME_POLL_MS) resumes live video the moment a consumer
  // attaches. Unknown counts (old extension) never pause: fail-safe live.
  // Boots PAUSED: launching the app must never light the camera LED. The
  // resume poll flips it live the moment a call app actually attaches.
  let webcamIdle = WEBCAM_IDLE_BOOT;
  let webcamPollTimer = null;

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
    const running = sinkConnected && pumpTimer !== null;
    return {
      available,
      running,
      // Intent without delivery: page loading/retrying or connect backoff.
      connecting: wantRunning && !running,
      frozen: running && frozen,
      fps: lastFps,
      paintFps: lastPaintFps,
      lastPaintAt,
      pumped: sink.pumped,
      droppedQueueFull: sink.droppedQueueFull,
      webcamIdle: webcamIdle.paused,
      error,
    };
  }

  // Read the extension's source-consumer count through the sink device.
  // Negative = unknown (addon predates sinkConsumers, sink not connected, or
  // the enabled extension has no 'ccon' property yet), which the reducer
  // treats as "assume watched".
  function readConsumers(native) {
    if (!native || typeof native.sinkConsumers !== "function") return -1;
    try {
      return native.sinkConsumers();
    } catch {
      return -1;
    }
  }

  // Push the current desired webcam state into the offscreen page. The page
  // has no preload by design, so this rides executeJavaScript: a sticky
  // window flag (read at WebcamFeed mount) plus a DOM event (flips a mounted
  // page live). Safe to call whenever; failures (page mid-navigation,
  // renderer gone) are non-fatal and the state is re-applied on the next
  // load and on every idle transition.
  function applyWebcamControl() {
    if (!win || win.isDestroyed()) return;
    win.webContents.executeJavaScript(webcamControlScript(webcamIdle.paused)).catch(() => {});
  }

  // Keep the fast resume poll running exactly while it can do something:
  // webcam paused AND a connected sink to read the consumer count through.
  function syncWebcamResumePoll() {
    const want = webcamIdle.paused && sinkConnected;
    if (want && !webcamPollTimer) {
      webcamPollTimer = setInterval(() => {
        const next = reduceWebcamIdleSecond(webcamIdle, readConsumers(loadAddon()));
        if (next.paused) return; // still unwatched
        webcamIdle = next;
        log.log("[camera] call app attached; resuming the webcam capture");
        applyWebcamControl();
        syncWebcamResumePoll();
        notify();
      }, WEBCAM_RESUME_POLL_MS);
    } else if (!want && webcamPollTimer) {
      clearInterval(webcamPollTimer);
      webcamPollTimer = null;
    }
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
        lastPaintAt = Date.now();
        if (!sawPaintSinceLoad) {
          sawPaintSinceLoad = true;
          maybeConnect();
        }
      }
    } catch (err) {
      pushErrors++;
      if (pushErrors <= 3) log.error("[camera] pushFrame failed:", err);
    } finally {
      tex.release();
    }
  }

  // The page proved itself (successful load AND real pixels in the ring):
  // only NOW bring the sink up. The extension drops its splash the moment
  // the sink stream starts, so connecting earlier would publish black or a
  // painted Chromium error page. Called from both gates; connects on
  // whichever lands last.
  function maybeConnect() {
    if (!pageReady || !sawPaintSinceLoad) return;
    if (wantRunning && !sinkConnected && !connectTimer) {
      attemptConnect(0); // notifies on success or schedules the next try
    }
  }

  // Successful load: clear the load error, reset the load backoff, and arm
  // the connect gate. did-finish-load ALSO fires for Chromium's own error
  // page, which loadFailedThisAttempt filters out (did-fail-load precedes).
  function onLoadFinished() {
    if (loadFailedThisAttempt) return;
    pageReady = true;
    loadAttempt = 0;
    // A fresh page defaults to a live webcam; re-assert a standing pause so
    // a reload (load retry, crash recovery) cannot relight the LED while
    // nobody is watching. The injected flag lands before React mounts.
    if (webcamIdle.paused) applyWebcamControl();
    const hadLoadError = error !== null && error.startsWith("Program Output");
    if (hadLoadError) {
      error = null;
      notify(); // recovered (possibly mid-run with the sink already connected)
    }
    maybeConnect();
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
    // While the window is down the pump keeps re-sending the last ring frame
    // (a freeze, not black; the frozen flag reports it). The recreated window
    // re-enters the same first-paint/load-retry lifecycle as a fresh start.
    recreateTimer = setTimeout(() => {
      recreateTimer = null;
      if (wantRunning && !disposed) createWindow();
    }, 1000);
  }

  // A failed main-frame load walks the connect backoff schedule, then keeps
  // retrying at LOAD_RETRY_MAX_DELAY_MS for as long as the camera is wanted
  // (a dev server can come back any time). Once the schedule is exhausted,
  // a connected sink is RELEASED so the extension's splash resumes instead
  // of an empty or stale ring being pumped forever.
  function onLoadFailed(_event, code, desc, _validatedUrl, isMainFrame) {
    if (disposed || !wantRunning || isMainFrame === false) return;
    loadFailedThisAttempt = true;
    pageReady = false;
    if (loadTimer) return; // a retry is already scheduled
    error = `Program Output failed to load: ${desc || code}`;
    log.warn(`[camera] ${error}`);
    const exhausted = loadAttempt >= SINK_CONNECT_DELAYS_MS.length;
    if (exhausted && sinkConnected) {
      log.warn("[camera] persistent load failure; releasing the sink so the splash resumes");
      releaseSink();
    }
    const delay = exhausted
      ? LOAD_RETRY_MAX_DELAY_MS
      : SINK_CONNECT_DELAYS_MS[loadAttempt];
    loadAttempt++;
    loadTimer = setTimeout(() => {
      loadTimer = null;
      if (wantRunning && !disposed && win && !win.isDestroyed()) doLoad();
    }, delay);
    notify();
  }

  function doLoad() {
    sawPaintSinceLoad = false;
    loadFailedThisAttempt = false;
    pageReady = false;
    win.loadURL(programOutputUrl(studioUrl));
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
    win.webContents.on("did-fail-load", onLoadFailed);
    win.webContents.on("did-finish-load", onLoadFinished);
    doLoad();
  }

  function destroyWindow() {
    if (recreateTimer) {
      clearTimeout(recreateTimer);
      recreateTimer = null;
    }
    if (loadTimer) {
      clearTimeout(loadTimer);
      loadTimer = null;
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
    zeroPaintSeconds = 0;
    frozen = false;
    stallSeconds = 0;
    // A standing webcam pause re-arms its resume poll on (re)connect.
    syncWebcamResumePoll();
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
      const sink = native.sinkStats();

      // Webcam idle: one 1Hz step of the consumer-count machine. Pausing
      // releases the page's physical webcam (LED off) and arms the fast
      // resume poll; resuming here covers the slow path (the poll usually
      // wins the race by design).
      const wasPaused = webcamIdle.paused;
      webcamIdle = reduceWebcamIdleSecond(webcamIdle, readConsumers(native));
      if (webcamIdle.paused !== wasPaused) {
        log.log(
          `[camera] ${
            webcamIdle.paused
              ? "no call app is consuming the camera; releasing the webcam capture"
              : "call app attached; resuming the webcam capture"
          }`
        );
        applyWebcamControl();
        syncWebcamResumePoll();
        notify();
      } else if (webcamIdle.paused) {
        // Re-assert a standing pause once a second: the transition-time
        // injection is fire-and-forget into a page whose React listener may
        // not have mounted yet. The page reconciles from the sticky flag on
        // mount, so this is belt and braces for the dangerous direction (a
        // lit LED while the machine believes the webcam is idle), and it is
        // idempotent on a page already paused.
        applyWebcamControl();
      }

      // Frozen: the pump is healthy but the page stopped painting, so the
      // camera is repeating one frame. Surfaced (state flag + tray label),
      // not auto-stopped: a static scene is sometimes intentional. While the
      // webcam is idled the page is EXPECTED to go quiet (the standing-by
      // card animates only subtly), so paused seconds never count as frozen.
      zeroPaintSeconds = lastPaintFps === 0 && !webcamIdle.paused ? zeroPaintSeconds + 1 : 0;
      const nowFrozen = zeroPaintSeconds >= FROZEN_AFTER_SECONDS;
      if (nowFrozen !== frozen) {
        frozen = nowFrozen;
        log.warn(`[camera] ${frozen ? "feed frozen (no paints)" : "feed painting again"}`);
        notify();
      }

      // Stalled: nothing enqueued while the queue sits pinned full, meaning
      // the extension stopped consuming (typically another sink client, e.g.
      // the spike, stole the consume loop and exited). Self-heal by
      // reconnecting through the normal backoff.
      stallSeconds = sinkStalledSecond(lastFps, sink.queueCount, sink.queueCapacity)
        ? stallSeconds + 1
        : 0;
      if (stallSeconds >= SINK_STALL_SECONDS) {
        log.warn("[camera] sink stalled (queue pinned full, nothing consumed); reconnecting");
        releaseSink();
        attemptConnect(0);
        return;
      }

      seconds++;
      if (process.env.CAPTURIA_CAMERA_LOG === "1" && seconds % 5 === 0) {
        log.log(
          `[camera] fps=${lastFps} paints=${lastPaintFps} pumped=${sink.pumped} droppedQueueFull=${sink.droppedQueueFull} queue=${sink.queueCount}/${sink.queueCapacity}`
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
    frozen = false;
  }

  // Stop pumping and hand the sink stream back to the extension (its splash
  // resumes). Keeps the window and the wanted flag: callers decide whether
  // this is a full stop or a reconnect/retry. The webcam idle state also
  // survives on purpose: a reconnect while nobody watches must not relight
  // the LED (the resume poll pauses with the sink and re-arms on reconnect).
  function releaseSink() {
    stopPump();
    if (!sinkConnected) return;
    const native = loadAddon();
    try {
      if (native) native.disconnectSink();
    } catch (err) {
      log.error("[camera] disconnectSink failed:", err);
    }
    sinkConnected = false;
    syncWebcamResumePoll();
    log.log("[camera] disconnected from the camera sink");
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
      stop({ keepError: true });
      return;
    }
    connectTimer = setTimeout(
      () => attemptConnect(attempt + 1),
      SINK_CONNECT_DELAYS_MS[attempt]
    );
  }

  // Begin (or retry) feeding the camera: load the Program Output page, and
  // connect the sink on its first paint. Idempotent while already wanted.
  // Returns the state snapshot so IPC callers get an immediate answer.
  function start() {
    if (disposed || wantRunning) return getState();
    const native = loadAddon(true);
    if (!native) {
      available = false;
      error = "Native camera module not built.";
      notify();
      return getState();
    }
    // (Re)allocate the owned IOSurface ring; also resets the addon counters.
    // Init throws on IOSurface allocation failure, and a tray click must
    // never become an uncaught main-process exception.
    try {
      native.init(CAMERA_WIDTH, CAMERA_HEIGHT);
    } catch (err) {
      log.error("[camera] ring allocation failed:", err);
      error = "Camera frame ring allocation failed.";
      notify();
      return getState();
    }
    wantRunning = true;
    error = null;
    loadAttempt = 0;
    createWindow();
    notify(); // connecting: true from here until the first paint connects
    return getState();
  }

  // Stop feeding and release everything (sink stream, pump, pending connect
  // and load retries, offscreen window). Also the cancel path for a pending
  // auto-connect. keepError preserves a fatal reason (crash loop, give-up)
  // for the UI; an operator-requested stop clears it.
  function stop({ keepError = false } = {}) {
    wantRunning = false;
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    releaseSink();
    destroyWindow();
    // The page holding the capture is gone with the window (Chromium drops
    // getUserMedia with the renderer), so the idle machine starts over
    // paused; the next consumer attach brings it back.
    webcamIdle = WEBCAM_IDLE_BOOT;
    syncWebcamResumePoll();
    if (!keepError) error = null;
    notify();
    return getState();
  }

  // The tray click: act on intent, so "Connecting…" cancels rather than
  // arming a second start underneath the pending one.
  function toggle() {
    return cameraToggleAction(getState()) === "stop" ? stop() : start();
  }

  // Final teardown on app quit; the feed cannot be restarted afterwards.
  function dispose() {
    if (disposed) return;
    stop({ keepError: true });
    disposed = true;
  }

  return { start, stop, toggle, getState, dispose };
}

module.exports = { createCameraFeed };
