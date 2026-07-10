// capturia-frames: the native half of the M7a camera-frame spike.
//
// Electron's shared-texture offscreen rendering delivers each painted frame as
// an IOSurfaceRef (process-local, valid until texture.release()). This addon
// copies that surface into an owned triple-buffered IOSurface ring, which is
// the exact shape the future CMIO camera extension sink wants
// (CMSampleBufferCreateForImageBuffer over IOSurface-backed CVPixelBuffers).
// For the spike it also measures copy cost and can snapshot the latest frame
// to PNG so the pipeline can be verified end to end without the extension.
//
// Deliberately plain C++ against the C APIs (IOSurface, CoreGraphics,
// ImageIO): builds with Command Line Tools alone, no Xcode, no ObjC runtime.
// The production path will swap the CPU row copy for a Metal blit if the
// numbers demand it; the spike measures first.

#include <napi.h>

#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreMediaIO/CMIOHardware.h>
#include <CoreVideo/CoreVideo.h>
#include <IOSurface/IOSurface.h>
#include <ImageIO/ImageIO.h>

#include <algorithm>
#include <chrono>
#include <cstring>

namespace {

constexpr int kRingSize = 3;

IOSurfaceRef g_ring[kRingSize] = {nullptr, nullptr, nullptr};
int g_head = -1;  // index of the most recent complete frame, -1 = none yet
size_t g_ringWidth = 0;
size_t g_ringHeight = 0;

uint64_t g_frames = 0;
uint64_t g_blankFrames = 0;
double g_copyMicrosTotal = 0;
double g_copyMicrosMax = 0;
size_t g_lastSrcWidth = 0;
size_t g_lastSrcHeight = 0;
uint32_t g_lastSrcFormat = 0;

CFNumberRef MakeCFNumber(int32_t value) {
  return CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &value);
}

IOSurfaceRef CreateBGRASurface(size_t width, size_t height) {
  CFMutableDictionaryRef props = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 4, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFNumberRef w = MakeCFNumber(static_cast<int32_t>(width));
  CFNumberRef h = MakeCFNumber(static_cast<int32_t>(height));
  CFNumberRef bpe = MakeCFNumber(4);
  CFNumberRef fmt = MakeCFNumber(static_cast<int32_t>('BGRA'));
  CFDictionarySetValue(props, kIOSurfaceWidth, w);
  CFDictionarySetValue(props, kIOSurfaceHeight, h);
  CFDictionarySetValue(props, kIOSurfaceBytesPerElement, bpe);
  CFDictionarySetValue(props, kIOSurfacePixelFormat, fmt);
  IOSurfaceRef surface = IOSurfaceCreate(props);
  CFRelease(fmt);
  CFRelease(bpe);
  CFRelease(h);
  CFRelease(w);
  CFRelease(props);
  return surface;
}

// init(width, height): allocate the owned ring.
Napi::Value Init(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "init(width, height)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_ringWidth = info[0].As<Napi::Number>().Uint32Value();
  g_ringHeight = info[1].As<Napi::Number>().Uint32Value();
  for (int i = 0; i < kRingSize; i++) {
    if (g_ring[i]) {
      CFRelease(g_ring[i]);
      g_ring[i] = nullptr;
    }
    g_ring[i] = CreateBGRASurface(g_ringWidth, g_ringHeight);
    if (!g_ring[i]) {
      Napi::Error::New(env, "IOSurfaceCreate failed").ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  g_head = -1;
  g_frames = 0;
  g_blankFrames = 0;
  g_copyMicrosTotal = 0;
  g_copyMicrosMax = 0;
  return env.Undefined();
}

// pushFrame(ioSurfaceHandle: Buffer) -> { seq, width, height, copyMicros, blank }
// The Buffer is Electron's textureInfo.handle.ioSurface: the raw IOSurfaceRef
// pointer, valid in this process until the caller invokes texture.release()
// AFTER this returns (the copy below is synchronous).
Napi::Value PushFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "pushFrame(ioSurfaceHandleBuffer)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
  if (buf.Length() < sizeof(void*)) {
    Napi::TypeError::New(env, "handle buffer too small").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  IOSurfaceRef src = nullptr;
  memcpy(&src, buf.Data(), sizeof(src));
  if (!src) {
    Napi::Error::New(env, "null IOSurfaceRef").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_head == -1 && !g_ring[0]) {
    Napi::Error::New(env, "call init(width, height) first").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  IOSurfaceLock(src, kIOSurfaceLockReadOnly, nullptr);
  const size_t srcW = IOSurfaceGetWidth(src);
  const size_t srcH = IOSurfaceGetHeight(src);
  const size_t srcBpr = IOSurfaceGetBytesPerRow(src);
  const uint8_t* srcBase = static_cast<const uint8_t*>(IOSurfaceGetBaseAddress(src));
  g_lastSrcWidth = srcW;
  g_lastSrcHeight = srcH;
  g_lastSrcFormat = IOSurfaceGetPixelFormat(src);

  const int next = (g_head + 1) % kRingSize;
  IOSurfaceRef dst = g_ring[next];
  IOSurfaceLock(dst, 0, nullptr);
  const size_t dstBpr = IOSurfaceGetBytesPerRow(dst);
  uint8_t* dstBase = static_cast<uint8_t*>(IOSurfaceGetBaseAddress(dst));

  const size_t rows = std::min(srcH, g_ringHeight);
  const size_t rowBytes = std::min({srcBpr, dstBpr, std::min(srcW, g_ringWidth) * 4});

  const auto t0 = std::chrono::steady_clock::now();
  for (size_t y = 0; y < rows; y++) {
    memcpy(dstBase + y * dstBpr, srcBase + y * srcBpr, rowBytes);
  }
  const auto t1 = std::chrono::steady_clock::now();
  const double micros =
      std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();

  // Blank probe: sample the center row's color channels (alpha is always 255,
  // so it must be excluded). All-zero RGB across the samples = blank frame.
  bool blank = true;
  if (rows > 0) {
    const uint8_t* mid = srcBase + (rows / 2) * srcBpr;
    const size_t px = std::min(srcW, g_ringWidth);
    for (size_t x = 0; x < px; x += 31) {
      const uint8_t* p = mid + x * 4;
      if (p[0] || p[1] || p[2]) {
        blank = false;
        break;
      }
    }
  }

  IOSurfaceUnlock(dst, 0, nullptr);
  IOSurfaceUnlock(src, kIOSurfaceLockReadOnly, nullptr);

  g_head = next;
  g_frames++;
  if (blank) g_blankFrames++;
  g_copyMicrosTotal += micros;
  g_copyMicrosMax = std::max(g_copyMicrosMax, micros);

  Napi::Object out = Napi::Object::New(env);
  out.Set("seq", Napi::Number::New(env, static_cast<double>(g_frames)));
  out.Set("width", Napi::Number::New(env, static_cast<double>(srcW)));
  out.Set("height", Napi::Number::New(env, static_cast<double>(srcH)));
  out.Set("copyMicros", Napi::Number::New(env, micros));
  out.Set("blank", Napi::Boolean::New(env, blank));
  return out;
}

// snapshot(path) -> bool. Writes the most recent ring frame as PNG.
Napi::Value Snapshot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "snapshot(path)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_head < 0) return Napi::Boolean::New(env, false);
  const std::string path = info[0].As<Napi::String>().Utf8Value();

  IOSurfaceRef surf = g_ring[g_head];
  IOSurfaceLock(surf, kIOSurfaceLockReadOnly, nullptr);
  void* base = IOSurfaceGetBaseAddress(surf);
  const size_t bpr = IOSurfaceGetBytesPerRow(surf);

  bool ok = false;
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  // BGRA in memory = 32-bit little-endian with premultiplied alpha first.
  CGContextRef ctx = CGBitmapContextCreate(
      base, g_ringWidth, g_ringHeight, 8, bpr, cs,
      kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
  if (ctx) {
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    if (image) {
      CFURLRef url = CFURLCreateFromFileSystemRepresentation(
          kCFAllocatorDefault, reinterpret_cast<const UInt8*>(path.c_str()),
          static_cast<CFIndex>(path.size()), false);
      if (url) {
        CGImageDestinationRef dest =
            CGImageDestinationCreateWithURL(url, CFSTR("public.png"), 1, nullptr);
        if (dest) {
          CGImageDestinationAddImage(dest, image, nullptr);
          ok = CGImageDestinationFinalize(dest);
          CFRelease(dest);
        }
        CFRelease(url);
      }
      CGImageRelease(image);
    }
    CGContextRelease(ctx);
  }
  CGColorSpaceRelease(cs);
  IOSurfaceUnlock(surf, kIOSurfaceLockReadOnly, nullptr);
  return Napi::Boolean::New(env, ok);
}

// stats() -> aggregate counters for the spike report.
Napi::Value Stats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("frames", Napi::Number::New(env, static_cast<double>(g_frames)));
  out.Set("blankFrames", Napi::Number::New(env, static_cast<double>(g_blankFrames)));
  out.Set("avgCopyMicros",
          Napi::Number::New(env, g_frames ? g_copyMicrosTotal / g_frames : 0));
  out.Set("maxCopyMicros", Napi::Number::New(env, g_copyMicrosMax));
  out.Set("lastWidth", Napi::Number::New(env, static_cast<double>(g_lastSrcWidth)));
  out.Set("lastHeight", Napi::Number::New(env, static_cast<double>(g_lastSrcHeight)));
  // FourCC as text, e.g. "BGRA".
  char fmt[5] = {0};
  fmt[0] = static_cast<char>((g_lastSrcFormat >> 24) & 0xff);
  fmt[1] = static_cast<char>((g_lastSrcFormat >> 16) & 0xff);
  fmt[2] = static_cast<char>((g_lastSrcFormat >> 8) & 0xff);
  fmt[3] = static_cast<char>(g_lastSrcFormat & 0xff);
  out.Set("lastPixelFormat", Napi::String::New(env, fmt));
  return out;
}

// ---------------------------------------------------------------------------
// CMIO sink client (M7b): feed the ring frames into the Capturia camera
// extension's SINK stream via the CoreMediaIO C API, the same host-side
// pattern OBS ships (CMIOStreamCopyBufferQueue + CMSimpleQueueEnqueue).
// ---------------------------------------------------------------------------

CMSimpleQueueRef g_sinkQueue = nullptr;
CMIODeviceID g_sinkDevice = 0;
CMIOStreamID g_sinkStream = 0;
CMFormatDescriptionRef g_sinkFormat = nullptr;
uint64_t g_pumped = 0;
uint64_t g_droppedFull = 0;

// Element 0 = the main/master element (the constant was renamed across SDKs).
CMIOObjectPropertyAddress PropAddr(CMIOObjectPropertySelector selector) {
  return {selector, kCMIOObjectPropertyScopeGlobal, 0};
}

std::string CopyCFString(CFStringRef str) {
  if (!str) return "";
  char buf[512] = {0};
  if (CFStringGetCString(str, buf, sizeof(buf), kCFStringEncodingUTF8)) {
    return std::string(buf);
  }
  return "";
}

std::string GetObjectString(CMIOObjectID object, CMIOObjectPropertySelector selector) {
  CMIOObjectPropertyAddress addr = PropAddr(selector);
  if (!CMIOObjectHasProperty(object, &addr)) return "";
  CFStringRef value = nullptr;
  UInt32 used = 0;
  OSStatus status = CMIOObjectGetPropertyData(object, &addr, 0, nullptr,
                                              sizeof(value), &used, &value);
  if (status != kCMIOHardwareNoError || !value) return "";
  std::string out = CopyCFString(value);
  CFRelease(value);
  return out;
}

std::vector<CMIODeviceID> CopyDeviceIDs() {
  std::vector<CMIODeviceID> devices;
  CMIOObjectPropertyAddress addr = PropAddr(kCMIOHardwarePropertyDevices);
  UInt32 byteSize = 0;
  if (CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, &addr, 0, nullptr,
                                    &byteSize) != kCMIOHardwareNoError ||
      byteSize == 0) {
    return devices;
  }
  devices.resize(byteSize / sizeof(CMIODeviceID));
  UInt32 used = 0;
  if (CMIOObjectGetPropertyData(kCMIOObjectSystemObject, &addr, 0, nullptr, byteSize,
                                &used, devices.data()) != kCMIOHardwareNoError) {
    devices.clear();
  }
  return devices;
}

std::vector<CMIOStreamID> CopyStreamIDs(CMIODeviceID device) {
  std::vector<CMIOStreamID> streams;
  CMIOObjectPropertyAddress addr = PropAddr(kCMIODevicePropertyStreams);
  UInt32 byteSize = 0;
  if (CMIOObjectGetPropertyDataSize(device, &addr, 0, nullptr, &byteSize) !=
          kCMIOHardwareNoError ||
      byteSize == 0) {
    return streams;
  }
  streams.resize(byteSize / sizeof(CMIOStreamID));
  UInt32 used = 0;
  if (CMIOObjectGetPropertyData(device, &addr, 0, nullptr, byteSize, &used,
                                streams.data()) != kCMIOHardwareNoError) {
    streams.clear();
  }
  return streams;
}

// listDevices() -> [{ id, name, uid, streams }]. Also a live smoke test of the
// CMIO C API against whatever cameras exist (real ones show up here too).
Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  uint32_t i = 0;
  for (CMIODeviceID device : CopyDeviceIDs()) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id", Napi::Number::New(env, device));
    o.Set("name", Napi::String::New(env, GetObjectString(device, kCMIOObjectPropertyName)));
    o.Set("uid",
          Napi::String::New(env, GetObjectString(device, kCMIODevicePropertyDeviceUID)));
    o.Set("streams",
          Napi::Number::New(env, static_cast<double>(CopyStreamIDs(device).size())));
    out.Set(i++, o);
  }
  return out;
}

// listStreams(deviceNameOrUid) -> [{ id, name, direction }]. Debug/diagnostic
// view of a device's streams, so sink selection is verifiable from JS.
Napi::Value ListStreams(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "listStreams(deviceNameOrUid)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string wanted = info[0].As<Napi::String>().Utf8Value();
  Napi::Array out = Napi::Array::New(env);
  for (CMIODeviceID device : CopyDeviceIDs()) {
    const std::string name = GetObjectString(device, kCMIOObjectPropertyName);
    const std::string uid = GetObjectString(device, kCMIODevicePropertyDeviceUID);
    if (name != wanted && uid != wanted) continue;
    uint32_t i = 0;
    for (CMIOStreamID stream : CopyStreamIDs(device)) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("id", Napi::Number::New(env, stream));
      o.Set("name",
            Napi::String::New(env, GetObjectString(stream, kCMIOObjectPropertyName)));
      CMIOObjectPropertyAddress dirAddr = PropAddr(kCMIOStreamPropertyDirection);
      UInt32 direction = 0;
      UInt32 used = 0;
      if (CMIOObjectGetPropertyData(stream, &dirAddr, 0, nullptr, sizeof(direction),
                                    &used, &direction) == kCMIOHardwareNoError) {
        o.Set("direction", Napi::Number::New(env, direction));
      } else {
        o.Set("direction", Napi::Number::New(env, -1));
      }
      out.Set(i++, o);
    }
    break;
  }
  return out;
}

void QueueAlteredNoop(CMIOStreamID, void*, void*) {}

// connectSink(deviceNameOrUid) -> bool. Finds the Capturia device, picks its
// SINK stream, copies the buffer queue, and starts the stream.
//
// DAL direction semantics (verified live against the Capturia extension, and
// the root cause of an early pumped=0 bug): kCMIOStreamPropertyDirection is 1
// for INPUT streams (device -> host, the normal camera source) and 0 for
// OUTPUT streams (host -> device, the sink we feed). Selecting direction 1
// grabs the SOURCE stream: its queue fills with the extension's own splash
// frames and every enqueue drops as "queue full" while viewers keep seeing
// the splash. OBS's "second stream" convention stays as the fallback.
Napi::Value ConnectSink(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "connectSink(deviceNameOrUid)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string wanted = info[0].As<Napi::String>().Utf8Value();

  for (CMIODeviceID device : CopyDeviceIDs()) {
    const std::string name = GetObjectString(device, kCMIOObjectPropertyName);
    const std::string uid = GetObjectString(device, kCMIODevicePropertyDeviceUID);
    if (name != wanted && uid != wanted) continue;

    std::vector<CMIOStreamID> streams = CopyStreamIDs(device);
    if (streams.size() < 2) return Napi::Boolean::New(env, false);

    CMIOStreamID sink = 0;
    for (CMIOStreamID stream : streams) {
      CMIOObjectPropertyAddress dirAddr = PropAddr(kCMIOStreamPropertyDirection);
      UInt32 direction = 1;
      UInt32 used = 0;
      if (CMIOObjectGetPropertyData(stream, &dirAddr, 0, nullptr, sizeof(direction),
                                    &used, &direction) == kCMIOHardwareNoError &&
          direction == 0) {  // 0 = output (host -> device): the sink
        sink = stream;
        break;
      }
    }
    if (!sink) sink = streams[1];  // OBS convention: second stream is the sink

    CMSimpleQueueRef queue = nullptr;
    if (CMIOStreamCopyBufferQueue(sink, QueueAlteredNoop, nullptr, &queue) !=
            kCMIOHardwareNoError ||
        !queue) {
      return Napi::Boolean::New(env, false);
    }
    if (CMIODeviceStartStream(device, sink) != kCMIOHardwareNoError) {
      CFRelease(queue);
      return Napi::Boolean::New(env, false);
    }
    g_sinkDevice = device;
    g_sinkStream = sink;
    g_sinkQueue = queue;
    g_pumped = 0;
    g_droppedFull = 0;
    return Napi::Boolean::New(env, true);
  }
  return Napi::Boolean::New(env, false);
}

// pumpFrame() -> bool. Wraps the freshest ring frame as an IOSurface-backed
// CMSampleBuffer and enqueues it into the sink. Call on a fixed 30fps cadence;
// re-sending the last frame when nothing new painted is exactly the
// repeat-last-frame behavior a camera needs. (The 3-deep ring means a slot is
// rewritten ~100ms after enqueue; the extension consumes within a frame, and
// the production path will move to a per-frame pool if tearing ever shows.)
Napi::Value PumpFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_sinkQueue || g_head < 0) return Napi::Boolean::New(env, false);
  if (CMSimpleQueueGetCount(g_sinkQueue) >= CMSimpleQueueGetCapacity(g_sinkQueue)) {
    g_droppedFull++;
    return Napi::Boolean::New(env, false);
  }

  CVPixelBufferRef pixelBuffer = nullptr;
  if (CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, g_ring[g_head], nullptr,
                                       &pixelBuffer) != kCVReturnSuccess ||
      !pixelBuffer) {
    return Napi::Boolean::New(env, false);
  }
  if (!g_sinkFormat) {
    CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixelBuffer,
                                                 &g_sinkFormat);
  }
  if (!g_sinkFormat) {
    CVPixelBufferRelease(pixelBuffer);
    return Napi::Boolean::New(env, false);
  }

  CMSampleTimingInfo timing = {};
  timing.duration = CMTimeMake(1, 30);
  timing.presentationTimeStamp = CMClockGetTime(CMClockGetHostTimeClock());
  timing.decodeTimeStamp = kCMTimeInvalid;

  CMSampleBufferRef sampleBuffer = nullptr;
  OSStatus status = CMSampleBufferCreateForImageBuffer(
      kCFAllocatorDefault, pixelBuffer, true, nullptr, nullptr, g_sinkFormat, &timing,
      &sampleBuffer);
  CVPixelBufferRelease(pixelBuffer);  // sample buffer holds its own reference
  if (status != noErr || !sampleBuffer) return Napi::Boolean::New(env, false);

  // The enqueue convention transfers our +1 reference to the dequeuer.
  if (CMSimpleQueueEnqueue(g_sinkQueue, sampleBuffer) != noErr) {
    CFRelease(sampleBuffer);
    g_droppedFull++;
    return Napi::Boolean::New(env, false);
  }
  g_pumped++;
  return Napi::Boolean::New(env, true);
}

Napi::Value DisconnectSink(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_sinkDevice && g_sinkStream) CMIODeviceStopStream(g_sinkDevice, g_sinkStream);
  if (g_sinkQueue) CFRelease(g_sinkQueue);
  if (g_sinkFormat) CFRelease(g_sinkFormat);
  g_sinkQueue = nullptr;
  g_sinkFormat = nullptr;
  g_sinkDevice = 0;
  g_sinkStream = 0;
  return env.Undefined();
}

Napi::Value SinkStats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("connected", Napi::Boolean::New(env, g_sinkQueue != nullptr));
  out.Set("pumped", Napi::Number::New(env, static_cast<double>(g_pumped)));
  out.Set("droppedQueueFull", Napi::Number::New(env, static_cast<double>(g_droppedFull)));
  // Live queue introspection: a queue that reads permanently full means the
  // extension is not consuming (or the wrong stream was selected).
  out.Set("queueCount",
          Napi::Number::New(env, g_sinkQueue ? CMSimpleQueueGetCount(g_sinkQueue) : 0));
  out.Set("queueCapacity",
          Napi::Number::New(env, g_sinkQueue ? CMSimpleQueueGetCapacity(g_sinkQueue) : 0));
  return out;
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("pushFrame", Napi::Function::New(env, PushFrame));
  exports.Set("snapshot", Napi::Function::New(env, Snapshot));
  exports.Set("stats", Napi::Function::New(env, Stats));
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("listStreams", Napi::Function::New(env, ListStreams));
  exports.Set("connectSink", Napi::Function::New(env, ConnectSink));
  exports.Set("pumpFrame", Napi::Function::New(env, PumpFrame));
  exports.Set("disconnectSink", Napi::Function::New(env, DisconnectSink));
  exports.Set("sinkStats", Napi::Function::New(env, SinkStats));
  return exports;
}

}  // namespace

NODE_API_MODULE(capturia_frames, InitModule)
