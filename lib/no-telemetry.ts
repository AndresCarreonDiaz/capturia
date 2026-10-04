// Side-effect module: import it FIRST in any file that loads
// @copilotkit/runtime. The runtime builds its Scarf telemetry client at module
// scope and reads COPILOTKIT_TELEMETRY_DISABLED right then, and ESM evaluates
// every import before the importing file's own body, so an assignment written
// in route.ts itself would land after the client already decided to report.
// Unconditional: app/privacy/page.tsx promises the app phones home to no one.
process.env.COPILOTKIT_TELEMETRY_DISABLED = "1";

export {};
