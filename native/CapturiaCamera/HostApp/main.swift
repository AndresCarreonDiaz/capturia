// Minimal host harness for the Capturia camera extension (M7b).
//
// System extensions can only be activated by an app in /Applications that
// embeds them under Contents/Library/SystemExtensions. This tiny app is that
// container for development: run its binary with "activate" / "deactivate"
// and it drives OSSystemExtensionRequest and reports the outcome. The real
// product will do the same from the Electron app's native layer with a guided
// approval UX (Camo-style); the request/delegate flow is identical.

import Foundation
import SystemExtensions

let extensionIdentifier = "com.capturia.camera.extension"

final class RequestDelegate: NSObject, OSSystemExtensionRequestDelegate {
  func request(
    _ request: OSSystemExtensionRequest,
    actionForReplacingExtension existing: OSSystemExtensionProperties,
    withExtension ext: OSSystemExtensionProperties
  ) -> OSSystemExtensionRequest.ReplacementAction {
    print("replacing \(existing.bundleShortVersion) with \(ext.bundleShortVersion)")
    return .replace
  }

  func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
    print("NEEDS APPROVAL: allow it in System Settings (General > Login Items & Extensions > Camera Extensions), then this process finishes on its own.")
  }

  func request(
    _ request: OSSystemExtensionRequest,
    didFinishWithResult result: OSSystemExtensionRequest.Result
  ) {
    switch result {
    case .completed:
      print("OK: request completed")
    case .willCompleteAfterReboot:
      print("OK: completes after reboot")
    @unknown default:
      print("OK: finished with result \(result.rawValue)")
    }
    exit(0)
  }

  func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
    print("FAILED: \(error.localizedDescription)")
    let ns = error as NSError
    print("        domain=\(ns.domain) code=\(ns.code)")
    exit(1)
  }
}

guard CommandLine.arguments.count > 1 else {
  // No args: print usage instead of firing a request. Doubles as the smoke
  // test that AMFI accepted the signature + provisioning profile (an app
  // claiming system-extension.install without a profile is SIGKILLed here).
  print("usage: CapturiaCameraHost <activate|deactivate>")
  exit(0)
}
let mode = CommandLine.arguments[1]
let delegate = RequestDelegate()

let request: OSSystemExtensionRequest
switch mode {
case "deactivate":
  request = .deactivationRequest(forExtensionWithIdentifier: extensionIdentifier, queue: .main)
default:
  request = .activationRequest(forExtensionWithIdentifier: extensionIdentifier, queue: .main)
}
request.delegate = delegate
OSSystemExtensionManager.shared.submitRequest(request)
print("submitted \(mode) request for \(extensionIdentifier); waiting...")
RunLoop.main.run()
