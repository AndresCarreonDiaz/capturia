import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
  InMemoryAgentRunner,
  BuiltInAgent,
} from "@copilotkit/runtime/v2";
import { anthropic } from "@ai-sdk/anthropic";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

const runtime = new CopilotRuntime({
  agents: {
    default: new BuiltInAgent({
      model: anthropic("claude-sonnet-4-6"),
      apiKey: process.env.ANTHROPIC_API_KEY,
      prompt: SYSTEM_PROMPT,
    }),
  },
  runner: new InMemoryAgentRunner(),
});

// single-route: all requests go to POST /api/copilotkit with { method, params, body } envelope.
// Omitting GET so the frontend's auto-detect falls back to single-route mode.
export const POST = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
  mode: "single-route",
});
