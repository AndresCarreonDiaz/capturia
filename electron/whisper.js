// Whisper transcription handler. Renderer sends an already-valid WAV buffer
// (16kHz mono 16-bit PCM); we write it to a temp file and pipe it through
// nodejs-whisper. Sending pre-encoded WAV means nodejs-whisper's ffmpeg path
// is skipped, so users don't need ffmpeg on their system.
//
// nodejs-whisper returns whisper-cli's full stdout, which includes timestamp
// prefixes like "[00:00:00.000 --> 00:00:05.000]  hello world". We strip the
// timestamps and concatenate to plain text before returning to the renderer.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

// base.en: 142MB, real-time on Apple Silicon, ~2x better accuracy than tiny.en.
// Bump to small.en (466MB) later if accuracy is still a complaint.
const MODEL_NAME = "base.en";
const TIMESTAMP_RE = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g;

let busy = false;

async function transcribeWav(wavBuffer) {
  // Defensive: callers go through ipc-schemas.assertBytes, but guard here too
  // so a bad buffer can't reach Buffer.from() and emit a confusing error.
  if (
    !(wavBuffer instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(wavBuffer) &&
    !Buffer.isBuffer(wavBuffer)
  ) {
    throw new Error("transcribeWav expects ArrayBuffer/TypedArray WAV bytes.");
  }
  if (busy) {
    throw new Error("A transcription is already in progress.");
  }
  busy = true;

  // Lazy-require so failed import doesn't crash app startup; the failure
  // surfaces only when the user actually tries to transcribe.
  let nodewhisper;
  try {
    ({ nodewhisper } = require("nodejs-whisper"));
  } catch (err) {
    busy = false;
    throw new Error(
      `nodejs-whisper not loadable: ${err.message}. Run \`npx nodejs-whisper download\` once to build whisper.cpp.`
    );
  }

  // Spoken audio is sensitive. Write it into a 0700 private temp dir (mkdtemp
  // already restricts to the owner) with a 0600 file, and remove the whole
  // dir afterwards so nothing survives a crash on shared /tmp.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `capturia-${randomUUID()}-`));
  const tmpPath = path.join(tmpDir, "audio.wav");
  fs.writeFileSync(tmpPath, Buffer.from(wavBuffer), { mode: 0o600 });

  try {
    const raw = await nodewhisper(tmpPath, {
      modelName: MODEL_NAME,
      autoDownloadModelName: MODEL_NAME,
      removeWavFileAfterTranscription: false,
      logger: { debug: () => {}, log: () => {}, error: console.error },
      whisperOptions: {
        outputInText: false,
        outputInSrt: false,
        outputInVtt: false,
        outputInJson: false,
        outputInJsonFull: false,
        outputInCsv: false,
        outputInLrc: false,
        outputInWords: false,
        translateToEnglish: false,
        wordTimestamps: false,
        timestamps_length: 20,
        splitOnWord: false,
        noGpu: false,
      },
    });

    const cleaned = String(raw)
      .replace(TIMESTAMP_RE, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    return cleaned;
  } finally {
    busy = false;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

module.exports = { transcribeWav };
