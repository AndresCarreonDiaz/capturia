import { defineConfig } from "vitest/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the "@/..." path alias the app uses (tsconfig paths: "@/*" -> "./*").
// Keyed as "@/" (not "@") so it never swallows scoped package names like
// "@copilotkit/..."; only imports that start with "@/" are rewritten to root.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@/": `${root}/` },
  },
  test: {
    // The libs under test are pure TS (no DOM, no Next runtime), so node is
    // both correct and fast. Browser/voice/render paths are out of scope here.
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
});
