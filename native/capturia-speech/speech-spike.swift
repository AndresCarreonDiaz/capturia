// M9 spike: prove Apple's on-device SpeechAnalyzer/SpeechTranscriber
// (macOS 26+) delivers sub-second volatile interim results, streamed as
// NDJSON the way the future Electron helper will emit them.
//
// Build:  swiftc -O speech-spike.swift -o speech-spike
// Run:    ./speech-spike --file audio.wav [--realtime]
//
// Output: one JSON object per line on stdout:
//   {"type":"ready","locale":"en-US"}
//   {"type":"interim","text":"show a live","atMs":1234}
//   {"type":"final","text":"Show a live counter of 500 viewers.","atMs":2456}
//   {"type":"done"}
// atMs is wall-clock ms since the first audio buffer was fed, so with
// --realtime (feed paced at 1x) interim latency reads directly off the log.
// File mode needs NO microphone permission, which keeps the spike runnable
// headless; the eventual helper swaps the file reader for AVCaptureSession.

import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    FileHandle.standardOutput.synchronizeFile()
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

let args = CommandLine.arguments
guard let fileFlag = args.firstIndex(of: "--file"), args.count > fileFlag + 1 else {
    fail("usage: speech-spike --file audio.wav [--realtime]")
}
let audioPath = args[fileFlag + 1]
let realtime = args.contains("--realtime")

let semaphore = DispatchSemaphore(value: 0)

Task {
    do {
        let locale = Locale(identifier: "en_US")

        // The transcriber module: volatile results are the sub-second
        // interims this whole milestone is about.
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: []
        )

        // Make sure the on-device model is installed (one-time download).
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            emit(["type": "downloading-model"])
            try await request.downloadAndInstall()
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            fail("no compatible audio format")
        }
        emit([
            "type": "format",
            "sampleRate": format.sampleRate,
            "channels": Int(format.channelCount),
            "commonFormat": Int(format.commonFormat.rawValue),
            "interleaved": format.isInterleaved,
        ])

        // Open the file so processingFormat matches the analyzer's format
        // (default processingFormat is deinterleaved Float32, which traps the
        // analyzer when it expects Int16). The wav itself is pre-converted by
        // afconvert outside; a mismatch fails loudly.
        let file = try AVAudioFile(
            forReading: URL(fileURLWithPath: audioPath),
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )
        let compatible = file.processingFormat.sampleRate == format.sampleRate
            && file.processingFormat.channelCount == format.channelCount
            && file.processingFormat.commonFormat == format.commonFormat

        let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
        try await analyzer.start(inputSequence: inputSequence)

        var startedAt: Date?
        func atMs() -> Int {
            guard let start = startedAt else { return 0 }
            return Int(Date().timeIntervalSince(start) * 1000)
        }

        // Results consumer: volatile results arrive with isFinal == false.
        let resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    emit([
                        "type": result.isFinal ? "final" : "interim",
                        "text": text,
                        "atMs": atMs(),
                    ])
                }
            } catch {
                emit(["type": "error", "message": "results: \(error)"])
            }
        }

        emit(["type": "ready", "locale": locale.identifier])

        if !compatible {
            fail("input format mismatch: convert the wav to the reported format first (afconvert)")
        }

        // Feed the file in ~100ms chunks in the analyzer's own format.
        // --realtime paces the feed at 1x so latency numbers mean something.
        let feedFormat = file.processingFormat
        let chunkFrames = AVAudioFrameCount(feedFormat.sampleRate / 10)
        startedAt = Date()
        var fedMs = 0
        while file.framePosition < file.length {
            guard let inBuffer = AVAudioPCMBuffer(pcmFormat: feedFormat, frameCapacity: chunkFrames) else {
                fail("buffer alloc failed")
            }
            // Guarded by framePosition: an exact-EOF read throws a bare
            // nilError from the converter layer instead of returning zero
            // frames, which killed earlier runs after the last real chunk.
            try file.read(into: inBuffer, frameCount: chunkFrames)
            if inBuffer.frameLength == 0 { break }
            inputBuilder.yield(AnalyzerInput(buffer: inBuffer))
            fedMs += Int(Double(inBuffer.frameLength) / feedFormat.sampleRate * 1000)
            if fedMs % 1000 < 100 {
                emit(["type": "fed", "audioMs": fedMs, "atMs": atMs()])
            }
            if realtime {
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        inputBuilder.finish()
        emit(["type": "feed-done", "audioMs": fedMs, "atMs": atMs()])
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            emit(["type": "finalize-error", "message": "\(error)"])
        }
        _ = await resultsTask.result
        emit(["type": "done", "atMs": atMs()])
    } catch {
        fail("\(error)")
    }
    semaphore.signal()
}

semaphore.wait()
