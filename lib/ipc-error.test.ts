// Pins the renderer-side unwrap of Electron IPC rejections (lib/ipc-error.ts):
// the "Error invoking remote method" wrapper must never reach the user.

import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "./ipc-error";

describe("ipcErrorMessage", () => {
  it("unwraps the double-wrapped shape a rejected invoke produces", () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'billing:activate': Error: That code has already been used."
        )
      )
    ).toBe("That code has already been used.");
  });

  it("unwraps the single-wrapped form when main threw a non-Error", () => {
    expect(
      ipcErrorMessage(new Error("Error invoking remote method 'keys:clear': vault unavailable"))
    ).toBe("vault unavailable");
  });

  it("passes a plain Error's message through untouched", () => {
    expect(ipcErrorMessage(new Error("Key looks malformed."))).toBe("Key looks malformed.");
  });

  it("stringifies a thrown string", () => {
    expect(ipcErrorMessage("something broke")).toBe("something broke");
  });

  it("stringifies a thrown non-Error object rather than crashing", () => {
    expect(ipcErrorMessage({ code: 42 })).toBe("[object Object]");
  });
});
