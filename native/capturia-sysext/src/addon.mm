// capturia-sysext: the OSSystemExtensionRequest bridge for in-app camera
// extension activation (M8 slice 2).
//
// macOS only accepts a system-extension activation request from the app that
// EMBEDS the extension (Contents/Library/SystemExtensions), running with that
// app's bundle identity, signed with com.apple.developer.system-extension.
// install authorized by a provisioning profile. That app is the packaged
// Electron shell, so the request has to run inside Electron main; this tiny
// N-API addon is that bridge. Kept separate from capturia-frames on purpose:
// frames is plain C++ against C APIs by design, while the SystemExtensions
// framework is Objective-C only, so this is the one ObjC++ (.mm, ARC) module.
//
// Surface (all decisions live in JS; this file only forwards the OS):
//   requestActivation(extensionId, onEvent) -> bool
//     Submits OSSystemExtensionRequest.activationRequest and streams every
//     delegate outcome into onEvent as one of:
//       { phase: "replacing", existingVersion, newVersion }   (informational)
//       { phase: "needsApproval" }
//       { phase: "completed", result: "completed" | "willCompleteAfterReboot" }
//       { phase: "failed", code, domain, message }
//     completed/failed are terminal; afterwards a new request may be made.
//     Returns false (submitting nothing) while a request is still in flight:
//     ONE request at a time keeps delegate/JS lifetimes trivial, and the OS
//     would supersede a duplicate anyway (OSSystemExtensionErrorDomain 12).
//
// The delegate answers the replacement question with Replace unconditionally:
// the embedded copy IS the product's current build, and the OS still gates
// the swap on team identity + user approval where required.
//
// Threading: delegate callbacks arrive on a private serial dispatch queue and
// hop to the JS thread through a ThreadSafeFunction. The TSFN is released on
// the terminal event, which is what lets the Electron process exit cleanly
// while no request is pending.

#include <napi.h>

#import <Foundation/Foundation.h>
#import <SystemExtensions/SystemExtensions.h>

#include <string>

namespace {

struct SysextEvent {
  std::string phase;    // replacing | needsApproval | completed | failed
  std::string result;   // for completed
  std::string existingVersion;
  std::string newVersion;
  std::string domain;   // for failed
  std::string message;  // for failed
  int code = 0;         // for failed
  bool terminal = false;
};

Napi::ThreadSafeFunction g_tsfn;
bool g_active = false;
// Strong references keep the request + delegate alive for the OS callback
// lifetime; cleared on the terminal event.
id g_delegate = nil;
OSSystemExtensionRequest* g_request = nil;
dispatch_queue_t g_queue = nil;

std::string FromNSString(NSString* s) {
  return s ? std::string([s UTF8String] ?: "") : std::string();
}

// Forward one delegate outcome to JS. Runs on the delegate queue, but only
// READS module state there: every mutation (the in-flight flag, dropping the
// strong refs, releasing the TSFN) happens inside the TSFN callback on the JS
// thread, so RequestActivation never races a write from another thread. The
// dispatch-queue ordering of submitRequest makes the JS-thread write of
// g_tsfn visible here, and no delegate callback can arrive after the terminal
// one, so the read-once is safe.
void EmitEvent(const SysextEvent& ev) {
  Napi::ThreadSafeFunction tsfn = g_tsfn;
  if (!tsfn) return;
  SysextEvent* copy = new SysextEvent(ev);
  tsfn.BlockingCall(copy, [](Napi::Env env, Napi::Function cb, SysextEvent* data) {
    Napi::Object out = Napi::Object::New(env);
    out.Set("phase", Napi::String::New(env, data->phase));
    if (data->phase == "completed") {
      out.Set("result", Napi::String::New(env, data->result));
    } else if (data->phase == "failed") {
      out.Set("code", Napi::Number::New(env, data->code));
      out.Set("domain", Napi::String::New(env, data->domain));
      out.Set("message", Napi::String::New(env, data->message));
    } else if (data->phase == "replacing") {
      out.Set("existingVersion", Napi::String::New(env, data->existingVersion));
      out.Set("newVersion", Napi::String::New(env, data->newVersion));
    }
    const bool terminal = data->terminal;
    delete data;
    // Reset BEFORE the callback runs so an onEvent handler that immediately
    // retries sees an idle bridge.
    if (terminal) {
      g_active = false;
      g_request = nil;
      g_delegate = nil;
      if (g_tsfn) {
        g_tsfn.Release();
        g_tsfn = Napi::ThreadSafeFunction();
      }
    }
    cb.Call({out});
  });
}

}  // namespace

@interface CapturiaSysextDelegate : NSObject <OSSystemExtensionRequestDelegate>
@end

@implementation CapturiaSysextDelegate

- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest*)request
                  actionForReplacingExtension:(OSSystemExtensionProperties*)existing
                                withExtension:(OSSystemExtensionProperties*)ext {
  SysextEvent ev;
  ev.phase = "replacing";
  ev.existingVersion = FromNSString(existing.bundleShortVersion);
  ev.newVersion = FromNSString(ext.bundleShortVersion);
  EmitEvent(ev);
  return OSSystemExtensionReplacementActionReplace;
}

- (void)requestNeedsUserApproval:(OSSystemExtensionRequest*)request {
  SysextEvent ev;
  ev.phase = "needsApproval";
  EmitEvent(ev);
}

- (void)request:(OSSystemExtensionRequest*)request
    didFinishWithResult:(OSSystemExtensionRequestResult)result {
  SysextEvent ev;
  ev.phase = "completed";
  ev.result = result == OSSystemExtensionRequestWillCompleteAfterReboot
                  ? "willCompleteAfterReboot"
                  : "completed";
  ev.terminal = true;
  EmitEvent(ev);
}

- (void)request:(OSSystemExtensionRequest*)request didFailWithError:(NSError*)error {
  SysextEvent ev;
  ev.phase = "failed";
  ev.code = static_cast<int>(error.code);
  ev.domain = FromNSString(error.domain);
  ev.message = FromNSString(error.localizedDescription);
  ev.terminal = true;
  EmitEvent(ev);
}

@end

namespace {

// requestActivation(extensionId: string, onEvent: (event) => void) -> bool
Napi::Value RequestActivation(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "requestActivation(extensionId, onEvent)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_active) return Napi::Boolean::New(env, false);

  const std::string extensionId = info[0].As<Napi::String>().Utf8Value();
  g_tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "capturia-sysext", 0 /* unlimited queue */,
      1 /* one thread (the delegate queue) */);
  g_active = true;

  if (!g_queue) {
    g_queue = dispatch_queue_create("com.capturia.sysext", DISPATCH_QUEUE_SERIAL);
  }
  NSString* identifier = [NSString stringWithUTF8String:extensionId.c_str()];
  OSSystemExtensionRequest* request =
      [OSSystemExtensionRequest activationRequestForExtension:identifier queue:g_queue];
  CapturiaSysextDelegate* delegate = [[CapturiaSysextDelegate alloc] init];
  request.delegate = delegate;
  g_request = request;
  g_delegate = delegate;
  [[OSSystemExtensionManager sharedManager] submitRequest:request];
  return Napi::Boolean::New(env, true);
}

// requestPending() -> bool. Lets JS know a request is in flight (e.g. after a
// renderer reload re-queries state while an approval is still pending).
Napi::Value RequestPending(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_active);
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("requestActivation", Napi::Function::New(env, RequestActivation));
  exports.Set("requestPending", Napi::Function::New(env, RequestPending));
  return exports;
}

}  // namespace

NODE_API_MODULE(capturia_sysext, InitModule)
