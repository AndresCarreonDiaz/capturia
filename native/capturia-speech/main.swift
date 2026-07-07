// capturia-speech: the on-device streaming transcription helper (M9).
// Electron main spawns this and reads NDJSON events from stdout; the spike
// that proved the approach (and its measured latencies) lives next to this
// file as speech-spike.swift + docs/m9-speechanalyzer-spike.md.
//
// Modes:
//   capturia-speech --mic [--locale en_US]
//   capturia-speech --file audio.wav [--realtime]   (testing; no mic TCC)
//
// Protocol (one JSON object per line on stdout):
//   {"type":"ready","locale":"en_US"}
//   {"type":"interim","text":"...","atMs":123}   volatile, will be revised
//   {"type":"final","text":"...","atMs":456}     committed sentence
//   {"type":"error","message":"..."}             fatal; process exits 1
//   {"type":"done"}                              input ended (file mode)
// Mic mode runs until SIGTERM/SIGINT (clean exit 0) or stdin closes, so an
// Electron parent that dies never leaves an orphaned mic capture.
//
// Capture uses AVCaptureSession rather than an AVAudioEngine input tap on
// purpose: the M9 research flagged a Bluetooth-mic tap bug on macOS 26.

import AVFoundation
import Foundation
import Speech

// MARK: - protocol plumbing

let stdoutLock = NSLock()
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    stdoutLock.lock()
    print(line)
    fflush(stdout)
    stdoutLock.unlock()
}

func fatalError(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

// MARK: - arguments

let args = CommandLine.arguments
let micMode = args.contains("--mic")
var filePath: String?
if let i = args.firstIndex(of: "--file"), args.count > i + 1 { filePath = args[i + 1] }
let realtime = args.contains("--realtime")
var localeId = "en_US"
if let i = args.firstIndex(of: "--locale"), args.count > i + 1 { localeId = args[i + 1] }

guard micMode || filePath != nil else {
    fatalError("usage: capturia-speech --mic [--locale en_US] | --file audio.wav [--realtime]")
}

// MARK: - mic capture via AVCaptureSession

final class MicSource: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "capturia.speech.mic")
    private let onBuffer: (AVAudioPCMBuffer) -> Void
    private let onDeviceLost: (String) -> Void
    private var converter: AVAudioConverter?
    private let targetFormat: AVAudioFormat
    private var observers: [NSObjectProtocol] = []

    init(
        targetFormat: AVAudioFormat,
        onBuffer: @escaping (AVAudioPCMBuffer) -> Void,
        onDeviceLost: @escaping (String) -> Void
    ) {
        self.targetFormat = targetFormat
        self.onBuffer = onBuffer
        self.onDeviceLost = onDeviceLost
    }

    func start() throws {
        guard let device = AVCaptureDevice.default(for: .audio) else {
            throw NSError(domain: "capturia", code: 1, userInfo: [NSLocalizedDescriptionKey: "no audio input device"])
        }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw NSError(domain: "capturia", code: 2, userInfo: [NSLocalizedDescriptionKey: "capture session rejected audio I/O"])
        }
        // A device unplugged mid-session (Bluetooth drop, input switch) or a
        // capture-session runtime error would otherwise leave a silent,
        // apparently-live session; the checklist requires an error instead.
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil
        ) { [weak self] note in
            guard (note.object as? AVCaptureDevice) === device else { return }
            self?.onDeviceLost("audio input device disconnected: \(device.localizedName)")
        })
        observers.append(center.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil
        ) { [weak self] note in
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? AVError
            self?.onDeviceLost("capture session error: \(error?.localizedDescription ?? "unknown")")
        })
        session.addInput(input)
        session.addOutput(output)
        session.startRunning()
    }

    func stop() {
        let center = NotificationCenter.default
        for observer in observers { center.removeObserver(observer) }
        observers.removeAll()
        session.stopRunning()
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pcm = Self.pcmBuffer(from: sampleBuffer) else { return }
        if pcm.format == targetFormat
            || (pcm.format.sampleRate == targetFormat.sampleRate
                && pcm.format.channelCount == targetFormat.channelCount
                && pcm.format.commonFormat == targetFormat.commonFormat) {
            onBuffer(pcm)
            return
        }
        // Convert whatever the device delivers (typically 48kHz float) to the
        // analyzer's format. One converter per source format; conversion is
        // per-buffer with an explicit end-of-data marker each call.
        if converter == nil || converter?.inputFormat != pcm.format {
            converter = AVAudioConverter(from: pcm.format, to: targetFormat)
        }
        guard let converter else { return }
        let ratio = targetFormat.sampleRate / pcm.format.sampleRate
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var served = false
        var conversionError: NSError?
        converter.convert(to: out, error: &conversionError) { _, status in
            if served {
                status.pointee = .noDataNow
                return nil
            }
            served = true
            status.pointee = .haveData
            return pcm
        }
        if conversionError == nil, out.frameLength > 0 {
            onBuffer(out)
        }
    }

    private static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return nil }
        guard let format = AVAudioFormat(streamDescription: asbd) else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frames),
            into: buffer.mutableAudioBufferList
        )
        return status == noErr ? buffer : nil
    }
}

// MARK: - transcription core

let semaphore = DispatchSemaphore(value: 0)

// Signal plumbing must live at top level: a DispatchSource local to a closure
// is deallocated (silently cancelled) when the closure returns, and a source
// scheduled on .main can never fire because the main thread parks in
// semaphore.wait() instead of draining a run loop. Either mistake makes
// SIGTERM inert while SIG_IGN suppresses the default kill, leaving the mic
// captured until the parent dies.
let stopQueue = DispatchQueue(label: "capturia.speech.stop")
var signalSources: [DispatchSourceSignal] = []

Task {
    do {
        // Stop plumbing before any async setup: a SIGTERM that lands during
        // the model download or analyzer startup must still exit cleanly
        // (a signal death reads as a crash to the Electron parent). Until
        // the capture pipeline exists, stopping is just a clean exit; mic
        // mode swaps in the graceful finalize-then-done path below.
        var stopped = false
        var gracefulStop: (() -> Void)?
        func requestStop() {
            if stopped { return }
            stopped = true
            guard let gracefulStop else {
                // File mode has no graceful path; a kill mid-transcription is
                // a failure and must say so on the wire, not exit 0 like a
                // completed run. Mic mode pre-pipeline keeps the clean exit.
                if filePath != nil {
                    emit(["type": "error", "message": "stopped before completion"])
                    exit(1)
                }
                exit(0)
            }
            gracefulStop()
            // Backstop: an analyzer that never got a buffer (mic permission
            // denied, dead device) can wedge finalize forever; stop must
            // still terminate the process.
            stopQueue.asyncAfter(deadline: .now() + 5) {
                emit(["type": "done"])
                exit(0)
            }
        }
        let installSignalHandler = { (signalName: Int32) in
            let source = DispatchSource.makeSignalSource(signal: signalName, queue: stopQueue)
            source.setEventHandler { requestStop() }
            source.resume()
            signal(signalName, SIG_IGN)
            signalSources.append(source)
        }
        installSignalHandler(SIGTERM)
        installSignalHandler(SIGINT)

        let locale = Locale(identifier: localeId)
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: []
        )

        // Idempotent: returns a request even when assets are present.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            emit(["type": "downloading-model"])
            try await request.downloadAndInstall()
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            fatalError("no compatible audio format")
        }

        let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
        try await analyzer.start(inputSequence: inputSequence)

        let startedAt = Date()
        @Sendable func atMs() -> Int { Int(Date().timeIntervalSince(startedAt) * 1000) }

        let resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    emit([
                        "type": result.isFinal ? "final" : "interim",
                        "text": String(result.text.characters),
                        "atMs": atMs(),
                    ])
                }
            } catch {
                // Protocol: error is fatal (exit 1). Staying alive here would
                // keep the mic captured with no results flowing and the
                // parent convinced the session is healthy.
                emit(["type": "error", "message": "results: \(error)"])
                exit(1)
            }
        }

        emit(["type": "ready", "locale": locale.identifier])

        if let filePath {
            // File mode: identical protocol, no mic permission, used by the
            // automated smoke. Details (Int16 format, EOF guard) proven in
            // the spike.
            let file = try AVAudioFile(
                forReading: URL(fileURLWithPath: filePath),
                commonFormat: format.commonFormat,
                interleaved: format.isInterleaved
            )
            guard file.processingFormat.sampleRate == format.sampleRate,
                  file.processingFormat.channelCount == format.channelCount else {
                fatalError("input format mismatch: expected \(format.sampleRate)Hz x\(format.channelCount)")
            }
            let chunkFrames = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
            while file.framePosition < file.length {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunkFrames) else {
                    fatalError("buffer alloc failed")
                }
                try file.read(into: buffer, frameCount: chunkFrames)
                if buffer.frameLength == 0 { break }
                inputBuilder.yield(AnalyzerInput(buffer: buffer))
                if realtime { try await Task.sleep(nanoseconds: 100_000_000) }
            }
            inputBuilder.finish()
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
            _ = await resultsTask.result
            emit(["type": "done", "atMs": atMs()])
            exit(0)
        }

        // Mic mode: run until the parent says stop (SIGTERM/SIGINT) or stdin
        // closes (parent death), then finalize what was heard and exit.
        let mic = MicSource(
            targetFormat: format,
            onBuffer: { buffer in inputBuilder.yield(AnalyzerInput(buffer: buffer)) },
            onDeviceLost: { message in
                emit(["type": "error", "message": message])
                exit(1)
            }
        )
        try mic.start()

        // Assigned on stopQueue so requestStop (which also only runs there)
        // never reads it mid-write; a signal landing before this block runs
        // takes the pre-pipeline exit, which the parent absorbs.
        stopQueue.async {
            gracefulStop = {
                mic.stop()
                inputBuilder.finish()
                Task {
                    try? await analyzer.finalizeAndFinishThroughEndOfInput()
                    _ = await resultsTask.result
                    emit(["type": "done", "atMs": atMs()])
                    exit(0)
                }
            }
        }

        // Parent-death watch: Electron closing our stdin means shut down.
        DispatchQueue.global().async {
            while readLine(strippingNewline: false) != nil {}
            stopQueue.async { requestStop() }
        }
    } catch {
        fatalError("\(error)")
    }
}

semaphore.wait()
