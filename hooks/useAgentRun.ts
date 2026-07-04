"use client";
import { useCallback, useEffect, useState } from "react";
import { useAgent, useCopilotKit, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { randomToken } from "@/lib/random-id";

// The v2 way to drive the BuiltInAgent so that client-registered frontend tools
// (useFrontendTool) actually execute. The v1 useCopilotChat().appendMessage path
// writes to the legacy GraphQL message store, which the v2 tool loop never reads,
// so handlers never fired (see docs/known-issues.md). Here we add the user turn
// to the AG-UI agent and run it through the CORE's runAgent, which is what
// commits the streamed tool-call message and calls processAgentResult ->
// tool.handler.
//
// Two hard-won constraints shape this hook:
//
// 1. runAgent does NOT queue: it detaches (cancels) any in-flight run first, so
//    sending while a turn streams would truncate that turn's tool calls and can
//    leave a dangling functionCall in the thread history that Gemini then
//    rejects. sendMessage therefore checks agent.isRunning AT CALL TIME (the
//    live instance property, immune to stale render closures) and DROPS the
//    turn, returning false. A dropped turn is a no-op by design, matching the
//    established tap semantics; the next utterance/tap simply fires again.
//
// 2. copilotkit.runAgent never rejects: run failures (429s, revoked keys, the
//    route's 503 guard) are swallowed into core error subscribers and resolve
//    as zero new messages. Without a subscriber the loop dies silently, so
//    this hook subscribes and surfaces the latest run error as state for the
//    operator notices; a subsequent successful send clears it.
//
// CALL THIS HOOK ONCE (the studio does, passing sendMessage/busy down as
// props). Before the runtime handshake completes, and permanently after a
// failed one, each useAgent() call site holds its OWN provisional agent with
// its own thread; two call sites would then run divergent conversations with
// inconsistent busy signals.
export function useAgentRun() {
  const { agent } = useAgent({ updates: [UseAgentUpdate.OnRunStatusChanged] });
  const { copilotkit } = useCopilotKit();
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error, code }) => {
        setRunError(`${String(code)}: ${error?.message ?? "unknown error"}`);
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit]);

  const sendMessage = useCallback(
    async (content: string): Promise<boolean> => {
      if (agent.isRunning) return false;
      setRunError(null);
      agent.addMessage({ id: randomToken(16), role: "user", content });
      await copilotkit.runAgent({ agent });
      return true;
    },
    [agent, copilotkit]
  );

  return { sendMessage, isRunning: agent.isRunning, runError };
}
