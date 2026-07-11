// Capturia CMIO Camera Extension (M7b).
//
// The virtual camera every call app sees. Two streams on one device, the
// pattern OBS ships (plugins/mac-virtualcam/src/camera-extension):
//   - a SOURCE stream that Zoom/Meet/Slack consume, and
//   - a SINK stream the Capturia host app feeds with composited frames
//     (webcam + agent overlays, produced by the offscreen Electron renderer;
//     see native/capturia-frames and docs/m7a-spike.md).
// While nothing feeds the sink, the source emits a generated splash frame so
// selecting "Capturia" in a call app never shows a frozen or black feed.
// The device also publishes a custom consumer-count property so the host app
// can idle its physical-webcam capture while no call app is watching.

import CoreMediaIO
import CoreVideo
import Foundation
import IOKit.audio
import IOSurface

let capturiaFrameRate = 30
let capturiaWidth = 1920
let capturiaHeight = 1080
// Stable device identity: changing this creates a "new" camera in call apps.
let capturiaDeviceUID = UUID(uuidString: "7A1C6E2D-9B4F-4C11-8A5E-CAB2C0FFEE01")!

// Custom device property: how many source-stream clients (Zoom, Photo Booth,
// ...) are consuming the camera right now, as a decimal string. The host app
// polls it through the sink connection so it can release its physical-webcam
// capture while nobody watches (issue #38: a lit camera LED with no visible
// app reads as spyware) and reacquire the moment a call app attaches.
// Custom CMIO extension properties must use the "4cc_<fourcc>_glob_0000"
// rawValue form; DAL clients read this one as selector 'ccon' with global
// scope on the main element (native/capturia-frames sinkConsumers()).
let capturiaConsumerCountProperty = CMIOExtensionProperty(rawValue: "4cc_ccon_glob_0000")

// MARK: - Provider

final class CapturiaProviderSource: NSObject, CMIOExtensionProviderSource {
  private(set) var provider: CMIOExtensionProvider!
  private var deviceSource: CapturiaDeviceSource!

  init(clientQueue: DispatchQueue?) {
    super.init()
    provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
    deviceSource = CapturiaDeviceSource(localizedName: "Capturia")
    do {
      try provider.addDevice(deviceSource.device)
    } catch {
      fatalError("addDevice failed: \(error.localizedDescription)")
    }
  }

  func connect(to client: CMIOExtensionClient) throws {}

  func disconnect(from client: CMIOExtensionClient) {}

  var availableProperties: Set<CMIOExtensionProperty> {
    [.providerManufacturer, .providerName]
  }

  func providerProperties(
    forProperties properties: Set<CMIOExtensionProperty>
  ) throws -> CMIOExtensionProviderProperties {
    let providerProperties = CMIOExtensionProviderProperties(dictionary: [:])
    if properties.contains(.providerManufacturer) {
      providerProperties.manufacturer = "Capturia"
    }
    if properties.contains(.providerName) {
      providerProperties.name = "Capturia Camera Provider"
    }
    return providerProperties
  }

  func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {}
}

// MARK: - Device (source + sink streams, splash generator)

final class CapturiaDeviceSource: NSObject, CMIOExtensionDeviceSource {
  private(set) var device: CMIOExtensionDevice!
  private var sourceStreamSource: CapturiaSourceStreamSource!
  private var sinkStreamSource: CapturiaSinkStreamSource!
  private var streamFormat: CMIOExtensionStreamFormat!

  private let stateQueue = DispatchQueue(label: "capturia.camera.state")
  private var splashTimer: DispatchSourceTimer?
  private var pixelBufferPool: CVPixelBufferPool?
  private var formatDescription: CMFormatDescription?
  // Set while the host app is streaming real frames into the sink; the splash
  // generator stands down.
  private var sinkActive = false
  private var splashTick: UInt64 = 0
  // Source-stream clients currently consuming (the framework coalesces
  // start/stop around the first/last client, so in practice this is 0 or 1;
  // counting keeps it correct either way). Guarded by stateQueue.
  private var sourceClientCount = 0

  init(localizedName: String) {
    super.init()
    device = CMIOExtensionDevice(
      localizedName: localizedName,
      deviceID: capturiaDeviceUID,
      legacyDeviceID: nil,
      source: self
    )

    var description: CMFormatDescription?
    CMVideoFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      codecType: kCVPixelFormatType_32BGRA,
      width: Int32(capturiaWidth),
      height: Int32(capturiaHeight),
      extensions: nil,
      formatDescriptionOut: &description
    )
    guard let description else { fatalError("CMVideoFormatDescriptionCreate failed") }
    formatDescription = description

    streamFormat = CMIOExtensionStreamFormat(
      formatDescription: description,
      maxFrameDuration: CMTime(value: 1, timescale: Int32(capturiaFrameRate)),
      minFrameDuration: CMTime(value: 1, timescale: Int32(capturiaFrameRate)),
      validFrameDurations: nil
    )

    let poolAttributes: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: capturiaWidth,
      kCVPixelBufferHeightKey as String: capturiaHeight,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
    ]
    CVPixelBufferPoolCreate(
      kCFAllocatorDefault, nil, poolAttributes as CFDictionary, &pixelBufferPool)

    sourceStreamSource = CapturiaSourceStreamSource(
      localizedName: "Capturia",
      streamFormat: streamFormat,
      device: device
    )
    sinkStreamSource = CapturiaSinkStreamSource(
      localizedName: "Capturia Sink",
      streamFormat: streamFormat,
      device: device,
      onFrame: { [weak self] sampleBuffer in
        self?.forwardSinkFrame(sampleBuffer)
      },
      onActiveChange: { [weak self] active in
        self?.stateQueue.async { self?.sinkActive = active }
      }
    )

    do {
      try device.addStream(sourceStreamSource.stream)
      try device.addStream(sinkStreamSource.stream)
    } catch {
      fatalError("addStream failed: \(error.localizedDescription)")
    }
  }

  var availableProperties: Set<CMIOExtensionProperty> {
    [.deviceTransportType, .deviceModel, capturiaConsumerCountProperty]
  }

  func deviceProperties(
    forProperties properties: Set<CMIOExtensionProperty>
  ) throws -> CMIOExtensionDeviceProperties {
    let deviceProperties = CMIOExtensionDeviceProperties(dictionary: [:])
    if properties.contains(.deviceTransportType) {
      deviceProperties.transportType = Int(kIOAudioDeviceTransportTypeVirtual)
    }
    if properties.contains(.deviceModel) {
      deviceProperties.model = "Capturia Virtual Camera"
    }
    if properties.contains(capturiaConsumerCountProperty) {
      let count = stateQueue.sync { sourceClientCount }
      deviceProperties.setPropertyState(
        consumerCountState(count),
        forProperty: capturiaConsumerCountProperty
      )
    }
    return deviceProperties
  }

  func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {}

  private func consumerCountState(_ count: Int) -> CMIOExtensionPropertyState<AnyObject> {
    CMIOExtensionPropertyState(value: String(count) as NSString)
  }

  // Notify property listeners and any client-side caches on every consumer
  // transition; the getter above still serves polls. Call on stateQueue.
  private func publishConsumerCount() {
    device.notifyPropertiesChanged([
      capturiaConsumerCountProperty: consumerCountState(sourceClientCount)
    ])
  }

  // MARK: source-stream lifecycle (called by CapturiaSourceStreamSource)

  func startStreaming() {
    stateQueue.async { [self] in
      sourceClientCount += 1
      publishConsumerCount()
      guard splashTimer == nil else { return }
      let timer = DispatchSource.makeTimerSource(queue: stateQueue)
      timer.schedule(
        deadline: .now(),
        repeating: .milliseconds(1000 / capturiaFrameRate)
      )
      timer.setEventHandler { [weak self] in
        guard let self, !self.sinkActive else { return }
        self.emitSplashFrame()
      }
      timer.resume()
      splashTimer = timer
    }
  }

  func stopStreaming() {
    stateQueue.async { [self] in
      sourceClientCount = max(0, sourceClientCount - 1)
      publishConsumerCount()
      splashTimer?.cancel()
      splashTimer = nil
    }
  }

  // The host app's composited frame arrived on the sink: forward it to the
  // apps consuming the source stream.
  private func forwardSinkFrame(_ sampleBuffer: CMSampleBuffer) {
    let hostNanos = UInt64(mach_absolute_time())
    sourceStreamSource.stream.send(
      sampleBuffer,
      discontinuity: [],
      hostTimeInNanoseconds: hostNanos
    )
  }

  // Animated placeholder so "Capturia" never looks dead before the host app
  // connects: dark studio background with a moving scanline.
  private func emitSplashFrame() {
    guard let pool = pixelBufferPool, let format = formatDescription else { return }
    var pixelBuffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBuffer)
    guard let pixelBuffer else { return }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    if let base = CVPixelBufferGetBaseAddress(pixelBuffer) {
      let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
      let height = CVPixelBufferGetHeight(pixelBuffer)
      memset(base, 0x10, bytesPerRow * height)
      let line = Int(splashTick % UInt64(height))
      memset(base.advanced(by: line * bytesPerRow), 0x2e, bytesPerRow)
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
    splashTick += 1

    var sampleBuffer: CMSampleBuffer?
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: Int32(capturiaFrameRate)),
      presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
      decodeTimeStamp: .invalid
    )
    CMSampleBufferCreateForImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: pixelBuffer,
      dataReady: true,
      makeDataReadyCallback: nil,
      refcon: nil,
      formatDescription: format,
      sampleTiming: &timing,
      sampleBufferOut: &sampleBuffer
    )
    if let sampleBuffer {
      sourceStreamSource.stream.send(
        sampleBuffer,
        discontinuity: [],
        hostTimeInNanoseconds: UInt64(mach_absolute_time())
      )
    }
  }
}

// MARK: - Source stream (what Zoom/Meet consume)

final class CapturiaSourceStreamSource: NSObject, CMIOExtensionStreamSource {
  private(set) var stream: CMIOExtensionStream!
  private let streamFormat: CMIOExtensionStreamFormat
  private weak var device: CMIOExtensionDevice?

  init(
    localizedName: String,
    streamFormat: CMIOExtensionStreamFormat,
    device: CMIOExtensionDevice
  ) {
    self.streamFormat = streamFormat
    self.device = device
    super.init()
    stream = CMIOExtensionStream(
      localizedName: localizedName,
      streamID: UUID(),
      direction: .source,
      clockType: .hostTime,
      source: self
    )
  }

  var formats: [CMIOExtensionStreamFormat] { [streamFormat] }

  var availableProperties: Set<CMIOExtensionProperty> {
    [.streamActiveFormatIndex, .streamFrameDuration]
  }

  func streamProperties(
    forProperties properties: Set<CMIOExtensionProperty>
  ) throws -> CMIOExtensionStreamProperties {
    let streamProperties = CMIOExtensionStreamProperties(dictionary: [:])
    if properties.contains(.streamActiveFormatIndex) {
      streamProperties.activeFormatIndex = 0
    }
    if properties.contains(.streamFrameDuration) {
      streamProperties.frameDuration = CMTime(value: 1, timescale: Int32(capturiaFrameRate))
    }
    return streamProperties
  }

  func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {}

  func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
    true
  }

  func startStream() throws {
    (deviceSourceOf(device))?.startStreaming()
  }

  func stopStream() throws {
    (deviceSourceOf(device))?.stopStreaming()
  }
}

// MARK: - Sink stream (fed by the Capturia host app)

final class CapturiaSinkStreamSource: NSObject, CMIOExtensionStreamSource {
  private(set) var stream: CMIOExtensionStream!
  private let streamFormat: CMIOExtensionStreamFormat
  private weak var device: CMIOExtensionDevice?
  private let onFrame: (CMSampleBuffer) -> Void
  private let onActiveChange: (Bool) -> Void
  private var client: CMIOExtensionClient?

  init(
    localizedName: String,
    streamFormat: CMIOExtensionStreamFormat,
    device: CMIOExtensionDevice,
    onFrame: @escaping (CMSampleBuffer) -> Void,
    onActiveChange: @escaping (Bool) -> Void
  ) {
    self.streamFormat = streamFormat
    self.device = device
    self.onFrame = onFrame
    self.onActiveChange = onActiveChange
    super.init()
    stream = CMIOExtensionStream(
      localizedName: localizedName,
      streamID: UUID(),
      direction: .sink,
      clockType: .hostTime,
      source: self
    )
  }

  var formats: [CMIOExtensionStreamFormat] { [streamFormat] }

  var availableProperties: Set<CMIOExtensionProperty> {
    [.streamActiveFormatIndex, .streamFrameDuration, .streamSinkBufferQueueSize]
  }

  func streamProperties(
    forProperties properties: Set<CMIOExtensionProperty>
  ) throws -> CMIOExtensionStreamProperties {
    let streamProperties = CMIOExtensionStreamProperties(dictionary: [:])
    if properties.contains(.streamActiveFormatIndex) {
      streamProperties.activeFormatIndex = 0
    }
    if properties.contains(.streamFrameDuration) {
      streamProperties.frameDuration = CMTime(value: 1, timescale: Int32(capturiaFrameRate))
    }
    if properties.contains(.streamSinkBufferQueueSize) {
      streamProperties.sinkBufferQueueSize = 4
    }
    return streamProperties
  }

  func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {}

  func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
    self.client = client
    return true
  }

  func startStream() throws {
    onActiveChange(true)
    consumeNext()
  }

  func stopStream() throws {
    onActiveChange(false)
    client = nil
  }

  // Pull loop: consume the host app's enqueued buffers one at a time and
  // forward each to the source stream. consumeSampleBuffer calls back when a
  // buffer is available; re-arm after each delivery.
  private func consumeNext() {
    guard let client else { return }
    stream.consumeSampleBuffer(from: client) {
      [weak self] sampleBuffer, sequenceNumber, discontinuity, hasMoreSampleBuffers, error in
      guard let self else { return }
      if let sampleBuffer {
        self.onFrame(sampleBuffer)
        self.stream.notifyScheduledOutputChanged(
          CMIOExtensionScheduledOutput(
            sequenceNumber: sequenceNumber,
            hostTimeInNanoseconds: UInt64(mach_absolute_time())
          )
        )
      }
      self.consumeNext()
    }
  }
}

// Helper: recover the device source from a CMIOExtensionDevice (its `source`
// is the protocol type).
private func deviceSourceOf(_ device: CMIOExtensionDevice?) -> CapturiaDeviceSource? {
  device?.source as? CapturiaDeviceSource
}

// MARK: - Entry point
//
// @main (not top-level statements) so the file compiles under Xcode, where
// top-level code is only allowed in a file named main.swift. build.sh passes
// -parse-as-library for the same reason.

@main
struct CapturiaCameraExtensionMain {
  static func main() {
    let providerSource = CapturiaProviderSource(clientQueue: nil)
    CMIOExtensionProvider.startService(provider: providerSource.provider)
    CFRunLoopRun()
  }
}
