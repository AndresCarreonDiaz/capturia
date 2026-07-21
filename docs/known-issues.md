# Known issues

## Fixed: desktop failure surfacing (issue #51)

The packaged app used to swallow its worst failures. A runtime-server start
failure fell back to `/api/copilotkit`, which does not exist on a `file://`
origin, so AI died with no message; a crashed or hung renderer and a failed
`file://` load were all the same black window. The shell now retries the
runtime start once and then surfaces each of these with a dialog (Retry /
Continue without AI, Reload / Quit, Wait / Reload, Retry the load) plus a
tray item, "Restart AI engine", that restarts the runtime and reloads the
studio on success. When the runtime is down on the static UI, `runtime:info`
hands the renderer an explicit `{ disabled: true }` instead of a fallback URL
that cannot work, and the studio shows the agent-offline banner. Every such
failure (plus main's `uncaughtException`/`unhandledRejection`) appends a
one-line JSON record to `crash.log` under `app.getPath("logs")` (macOS:
`~/Library/Logs/Capturia/`), capped in size; record shape and cap live in
`lib/crash-log.ts`. No third-party crash service, by design.

## FIXED: agent tool calls now render overlays in the browser

**Status:** FIXED 2026-07-02. Root cause was a wiring mistake, not a CopilotKit
bug: the app drove the v2 runtime with the **v1 client** (`@copilotkit/react-core`
bare package: `useCopilotChat().appendMessage` + `@copilotkit/runtime-client-gql`
`TextMessage`, and `useCopilotAction`). The v1 send path writes to the legacy
GraphQL message store, while the v2 tool loop (`CopilotKitCore.processAgentResult`)
reads the AG-UI `agent.messages` store, so the streamed tool-call message never
reached the loop and no handler ran.

**Fix (no package change; stayed on 1.57.1):** migrate the client to the
`@copilotkit/react-core/v2` hooks that already ship in 1.57.1:
- Provider: `CopilotKit` -> `CopilotKitProvider` (with `useSingleEndpoint`).
- Tools: the 8 `useCopilotAction({ parameters: [...], handler })` -> `useFrontendTool({ parameters: z.object({...}), handler })` (Standard Schema; Zod v4 already a dep). Each carries `followUp: false` so a command stays a single model call (fire-and-forget; the overlay is the output, no tool-result round trip).
- Readables: `useCopilotReadable` -> `useAgentContext`.
- Send + busy state: `useCopilotChat().appendMessage(new TextMessage(...))` -> a shared `hooks/useAgentRun.ts` = `useAgent()` + `useCopilotKit().copilotkit.runAgent({ agent })`, with a reactive `isRunning` from `useAgent({ updates: [OnRunStatusChanged] })`. Used by both the studio and CommandBar.
- `maxSteps` stays 1 (with `followUp: false`, one model call emits all tool calls at once, no roundtrip).

Verified end to end: `e2e/studio.spec.ts` "a typed command drives the real agent
loop into a rendered overlay" now passes against a live Gemini key (also covers
Surface Mode rendering through the real A2UI runtime and a second turn on the
same thread). Verify the full authored-surface + interactive-ActionButton loop
via docs/e2e-checklist.md.

**Post-migration hardening (same day, from a follow-up multi-agent review):**
- v2's `runAgent` CANCELS an in-flight run instead of queueing, so every send
  path now drops the turn when a run is live, checked on the live agent
  instance inside `useAgentRun.sendMessage` (immune to stale render closures).
  Previously rapid speech could truncate a streaming turn and corrupt the
  thread with a dangling tool call.
- `runAgent` never rejects (errors go to core subscribers only), so
  `useAgentRun` subscribes to `onError` and the studio shows an "Agent run
  failed" notice; without it a 429 or revoked key killed the loop silently.
- `useAgentRun` is called ONCE (the studio) and passed to CommandBar as props:
  before the runtime handshake resolves (or forever after a failed one), each
  `useAgent()` call site holds its own provisional agent with its own thread.
- Gemini sometimes emits JSON-carrying tool params PRE-PARSED (nested
  object/array instead of the described string) and nothing re-validates
  against the Zod schema; all handlers now coerce via
  `coerceRecordArg`/`coerceArrayArg`/`toolArgText` (lib/extract-json.ts).
- The thinking allowlist and every provider comparison are normalized through
  `canonicalProvider`/`isNoThinkingModel` (lib/server-keys.ts), so alias
  spellings (`gemini/...`, `google:...`, case variants) can't dodge the
  empty-response fix or the BYOK model override.
- Dropped the v1-era provider remount `key`: the v2 provider applies `headers`
  changes in place, and the remount wiped overlays/deck/vote room on a
  mid-session provider switch.

### Original diagnosis (kept for history)

Found 2026-07-02 during the first real browser E2E run of the agent loop with a
live Google key.

**Symptom:** you type or say a command, the agent decides on an overlay, but
nothing appears on the feed. The 8 `useCopilotAction` handlers (`add_overlay`,
`render_surface`, etc.) never run.

**What actually happens (traced end to end):**

1. The command reaches the agent. The server runs and streams a clean,
   correct tool call. Captured stream for "Add a progress bar at 73%":
   `RUN_STARTED > TOOL_CALL_START(add_overlay) > TOOL_CALL_ARGS(valid ProgressBar
   JSON) > TOOL_CALL_END > RUN_FINISHED`. No error, valid args.
2. On the client, `CopilotKitCore` has the tools registered (verified:
   `getTool("add_overlay")` returns the handler on the same core that runs the
   agent, so it is a single core, not a duplicate-instance problem).
3. But `agent.runAgent()` returns `newMessages = []`, and after the run
   `agent.messages` contains only the `user` message. The streamed assistant
   tool-call message is pushed into the run's working copy by `@ag-ui/client`'s
   `ae()` handler, then pruned before finalize (an un-resulted tool call is not
   persisted).
4. `CopilotKitCore.processAgentResult` iterates `newMessages` to execute
   client-provided tools. With `newMessages` empty, it executes nothing and the
   handler never fires.

**Root cause:** an incompatibility in the pinned stack,
`@copilotkit/react-core` / `@copilotkit/core` / `@copilotkit/runtime` 1.57.1
with `@ag-ui/client` / `@ag-ui/core` 0.0.53, for the tool-calls-only response
shape Capturia depends on (`BuiltInAgent`, `maxSteps: 1`, no assistant text,
client-provided frontend tools). Not a Capturia logic bug: the server output is
correct and the tools are registered on the right core.

**Not the cause (ruled out during diagnosis):**
- Gemini not emitting the tool call. It does (see the separate thinking fix
  below).
- `maxSteps`. Tried 1 and 3, identical failure.
- Duplicate CopilotKit/AG-UI copies or version skew. Single copies, aligned
  versions.
- Server emitting a synthetic tool result that makes the client skip. It does
  not; the stream is clean.

**Fix options (a direction decision, not a config tweak):**
1. ~~Upgrade CopilotKit past 1.57.1~~ TESTED 2026-07-02: bumped all
   `@copilotkit/*` to 1.62.1 (latest 1.x; pulled `@ag-ui/*` 0.0.57). tsc clean,
   but the render E2E STILL FAILS identically. So the 1.x line does not fix it;
   the next stable is a breaking `2.0.0-next`. Reverted to pinned 1.57.1. Do not
   re-try a 1.x bump. A 2.0 migration is possible but high-churn given the mixed
   v1/v2 usage.
2. Drive the tool loop ourselves: POST the run to `/api/copilotkit`, parse the
   AG-UI SSE stream (the event shape is already known and stable), accumulate
   `TOOL_CALL_ARGS`, and dispatch to the existing overlay-mutation functions
   directly. Removes the dependency on CopilotKit's post-run tool execution and
   the fragile v1/v2 mix, and aligns with the desktop plan (runtime hosted in
   Electron main, client drives overlays). More code, most robust.
3. Server-side: emit a `MESSAGES_SNAPSHOT` (or otherwise finalize the assistant
   tool-call message) after the tool call so the client commits it. Smallest if
   the v2 runtime exposes the hook; needs confirmation it does.

The `e2e/studio.spec.ts` "typed command ... rendered overlay" test is
`test.fixme` and pins this. Flip it to `test()` when fixed.

## Fixed: Gemini 2.5 Flash returned an empty response (thinking on)

`app/api/copilotkit/[[...slug]]/route.ts`. With `CAPTURIA_MODEL=google/gemini-2.5-flash`
and the full system prompt, the model "thinks" and then returns `finishReason:
STOP` with zero parts and zero candidate tokens, i.e. no tool call at all.
Reproduced against the raw `streamGenerateContent` API, so it is model behavior,
not CopilotKit. Fixed by passing `providerOptions.google.thinkingConfig.thinkingBudget
= 0` for `gemini-2.5-flash` and `gemini-2.5-flash-lite` (allowlist; 2.5-pro
rejects budget 0 and Gemini 3.x requires thinking). Verified at the model layer:
the tool call is now emitted. End-to-end render is still blocked by the
CopilotKit issue above.
