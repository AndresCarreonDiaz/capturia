import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Browser E2E for the flows unit tests can't reach: the /vote phone page over
// real SSE, and the studio agent loop. Run with `npm run test:e2e`; unit tests
// stay on vitest (`npm test`). See docs/e2e-checklist.md for the manual paths
// (real mic, real phone QR scan, OBS, Electron).

// The agent-loop spec drives a live model turn, so it only runs when a Google
// key is available. The dev server reads .env.local on its own; the test
// process just needs to know whether the key exists (never the value).
function hasGoogleKey(): boolean {
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return true;
  try {
    const env = fs.readFileSync(path.join(__dirname, ".env.local"), "utf8");
    return /^GOOGLE_GENERATIVE_AI_API_KEY=.+/m.test(env);
  } catch {
    return false;
  }
}
process.env.CAPTURIA_E2E_HAS_KEY = hasGoogleKey() ? "1" : "";

export default defineConfig({
  testDir: "./e2e",
  // One worker: the vote rooms live in the dev server's single in-memory
  // store, and serialized runs keep SSE assertions deterministic.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    // Fake media devices so getUserMedia (WebcamFeed) works headless without
    // a permission prompt.
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
