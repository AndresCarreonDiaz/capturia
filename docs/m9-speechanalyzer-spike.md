# M9 spike: Apple SpeechAnalyzer streaming transcription

**Verdict: PASS.** Apple's on-device `SpeechAnalyzer`/`SpeechTranscriber`
(macOS 26+) delivers what the M9 plan hoped for, measured on a real run
(macOS 26.5.1, Apple Silicon, en_US on-device model):

- **Sentence-level FINAL results arrive about 100ms after each spoken
  sentence ends, during uninterrupted speech.** No pause needed: a 17s
  six-sentence monologue produced six finals, each right behind its
  sentence. Today's chunked-whisper path only gets text after a VAD pause.
- **Volatile interim results flow in ~1s batches** tracking the words as
  they are spoken ("show a big counter" was on the wire while the phrase
  was still being said; effective interim latency 0.5-1.0s).
- **Numbers survive**: "thirty percent" -> "30%", "five hundred" -> "500",
  "eighty percent" -> "80%". Good for cue matching; deck priming still
  guards exactness.
- On-device model downloads once through `AssetInventory`; no network
  after that, no session caps, no API key.

## How to re-run

```
cd native/capturia-speech
swiftc -O speech-spike.swift -o speech-spike
say "your test sentence" -o /tmp/t.aiff
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/t.aiff /tmp/t.wav
./speech-spike --file /tmp/t.wav --realtime
```

NDJSON events on stdout: `ready`, `fed` (feed progress), `interim`,
`final`, `feed-done`, `done`. With `--realtime` the feed is paced at 1x so
`atMs` timestamps read as real latency. File mode needs no microphone
permission, so this runs headless; the production helper swaps the file
reader for `AVCaptureSession` (note: known Bluetooth-mic tap bug on
macOS 26 per the research in issue #8).

## Sharp edges found (already handled in the spike)

- The analyzer wants **Int16 interleaved 16kHz mono**
  (`bestAvailableAudioFormat`); `AVAudioFile`'s default `processingFormat`
  is deinterleaved Float32 and feeding it traps the process. Open the file
  with `AVAudioFile(forReading:commonFormat:interleaved:)` matching the
  analyzer's format.
- Reading an `AVAudioFile` at exact EOF **throws a bare `nilError`**
  instead of returning zero frames (when opened with a converting
  processing format). Guard reads with `framePosition < length`.
- `reportingOptions: [.volatileResults, .fastResults]` is the combination
  that streams; volatile alone worked but `.fastResults` is what the live
  helper wants.
- First-ever run downloads the model (`AssetInventory
  .assetInstallationRequest`); the request also returns non-nil on later
  runs, so treat it as idempotent, not as a "first run" signal.

## What productizing needs (the next M9 slice)

1. `capturia-speech` helper binary: `--mic` mode via `AVCaptureSession`
   (research flags a Bluetooth-mic tap bug on macOS 26: test wired/built-in
   first), same NDJSON protocol, locale from args.
2. Electron main spawns it, guards it with the same session discipline as
   whisper, and exposes a `TranscriptStream` engine
   (`id: "apple-speech", latencyClass: "subsecond"`) behind the existing
   contract in `lib/transcript-stream.ts`.
3. The studio replaces chunked-whisper with it when available (macOS 26+),
   keeping whisper as the fallback for macOS 13-15.
4. Packaging: ship the helper in `Contents/Resources`, signed with the app
   when signing lands (#6/#7 hooks already exist).
