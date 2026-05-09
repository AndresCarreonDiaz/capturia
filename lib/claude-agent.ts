import { AbstractAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { Observable, Subject } from "rxjs";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./system-prompt";

// Extract text content from AG-UI user message (which can be string or content-block array)
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (typeof c === "object" && c !== null && "text" in c) return (c as { text: string }).text;
        return "";
      })
      .join("");
  }
  return "";
}

function toAnthropicMessages(messages: RunAgentInput["messages"]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") continue;

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) result.push({ role: "user", content: text });
      continue;
    }

    if (msg.role === "assistant") {
      const assistantMsg = msg as {
        role: "assistant";
        content?: unknown;
        toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };

      if (assistantMsg.toolCalls?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts: any[] = [];
        const text = extractText(assistantMsg.content);
        if (text) parts.push({ type: "text", text });
        for (const tc of assistantMsg.toolCalls) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
          parts.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        if (parts.length) result.push({ role: "assistant", content: parts });
      } else {
        const text = extractText(assistantMsg.content);
        if (text) result.push({ role: "assistant", content: text });
      }
      continue;
    }

    // Tool results
    const toolMsg = msg as { role: string; toolCallId?: string; content?: unknown };
    if (toolMsg.toolCallId) {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: toolMsg.toolCallId,
            content: extractText(toolMsg.content) || "done",
          },
        ],
      });
    }
  }

  return result;
}

export class ClaudeAgent extends AbstractAgent {
  private anthropic: Anthropic;

  constructor() {
    super({ description: "LiveStage AI overlay agent" });
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  // Use `any` for Observable generic to avoid fighting AG-UI's complex BaseEvent union
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(input: RunAgentInput): Observable<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subject = new Subject<any>();

    const execute = async () => {
      subject.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });

      const messages = toAnthropicMessages(input.messages ?? []);
      if (messages.length === 0) messages.push({ role: "user", content: "Start" });

      const tools: Anthropic.Messages.Tool[] = (input.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: (t.parameters as Anthropic.Messages.Tool["input_schema"]) ?? {
          type: "object" as const,
          properties: {},
        },
      }));

      const stream = this.anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
        ...(tools.length > 0 && { tools, tool_choice: { type: "auto" } }),
      });

      let textMsgId: string | null = null;
      let toolCallId: string | null = null;

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "text") {
              textMsgId = `text-${event.index}-${input.runId}`;
              subject.next({ type: EventType.TEXT_MESSAGE_START, messageId: textMsgId, role: "assistant" });
            } else if (event.content_block.type === "tool_use") {
              toolCallId = event.content_block.id;
              subject.next({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: event.content_block.name });
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta" && textMsgId) {
              subject.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textMsgId, delta: event.delta.text });
            } else if (event.delta.type === "input_json_delta" && toolCallId) {
              subject.next({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: event.delta.partial_json });
            }
            break;

          case "content_block_stop":
            if (textMsgId) {
              subject.next({ type: EventType.TEXT_MESSAGE_END, messageId: textMsgId });
              textMsgId = null;
            } else if (toolCallId) {
              subject.next({ type: EventType.TOOL_CALL_END, toolCallId });
              toolCallId = null;
            }
            break;
        }
      }

      subject.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
      subject.complete();
    };

    execute().catch((err) => subject.error(err));
    return subject.asObservable();
  }
}
