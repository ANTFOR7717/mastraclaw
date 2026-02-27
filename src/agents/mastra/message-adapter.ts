/**
 * Converts between OpenClaw's AgentMessage format (pi-agent-core) and
 * Mastra's CoreMessage format (Vercel AI SDK).
 *
 * AgentMessage roles: "user" | "assistant" | "tool"
 * CoreMessage roles:  "user" | "assistant" | "tool" | "system"
 *
 * The content shapes are compatible at the structural level.
 * This adapter normalizes edge cases and ensures round-trip fidelity.
 */

import type { CoreMessage } from "@mastra/core/llm";

type AgentMessageRole = "user" | "assistant" | "tool";

type AgentMessageContent =
  | string
  | Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      result?: unknown;
      [key: string]: unknown;
    }>;

type AgentMessage = {
  role: AgentMessageRole;
  content: AgentMessageContent;
  [key: string]: unknown;
};

/**
 * Convert an array of pi-agent-core AgentMessages to Mastra CoreMessages.
 * System messages are handled separately (passed as agent instructions).
 */
export function toCoreMessages(messages: unknown[]): CoreMessage[] {
  const result: CoreMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const m = msg as AgentMessage;

    if (m.role === "user") {
      result.push(convertUserMessage(m));
    } else if (m.role === "assistant") {
      result.push(convertAssistantMessage(m));
    } else if (m.role === "tool") {
      result.push(convertToolMessage(m));
    }
    // Skip unknown roles (e.g. custom entries)
  }

  return result;
}

/**
 * Convert a Mastra CoreMessage back to a pi-agent-core AgentMessage shape.
 * Used when persisting Mastra responses back to JSONL session files.
 */
export function fromCoreMessage(msg: CoreMessage): AgentMessage | null {
  if (msg.role === "user") {
    return {
      role: "user",
      content:
        typeof msg.content === "string" ? msg.content : normalizeContentToString(msg.content),
    };
  }

  if (msg.role === "assistant") {
    const content = msg.content;
    if (typeof content === "string") {
      return { role: "assistant", content };
    }
    if (Array.isArray(content)) {
      return { role: "assistant", content: content as AgentMessageContent };
    }
    return { role: "assistant", content: String(content ?? "") };
  }

  if (msg.role === "tool") {
    return {
      role: "tool",
      content: Array.isArray(msg.content) ? (msg.content as AgentMessageContent) : [],
    };
  }

  return null;
}

// --- Internal helpers ---

function convertUserMessage(m: AgentMessage): CoreMessage {
  if (typeof m.content === "string") {
    return { role: "user", content: m.content };
  }

  if (Array.isArray(m.content)) {
    // Map content blocks to CoreMessage user content parts
    const parts = m.content.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "image" && typeof block.data === "string") {
        return {
          type: "image" as const,
          image: block.data,
          mimeType: block.mimeType ?? "image/jpeg",
        };
      }
      // Fallback: stringify unknown block types
      return { type: "text" as const, text: JSON.stringify(block) };
    });
    return { role: "user", content: parts };
  }

  return { role: "user", content: String(m.content ?? "") };
}

function convertAssistantMessage(m: AgentMessage): CoreMessage {
  if (typeof m.content === "string") {
    return { role: "assistant", content: m.content };
  }

  if (Array.isArray(m.content)) {
    const parts: Array<{
      type: "text" | "tool-call";
      text?: string;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
    }> = [];

    for (const block of m.content) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "toolCall" || block.type === "tool_use") {
        parts.push({
          type: "tool-call",
          toolCallId: block.toolCallId ?? (block.id as string | undefined) ?? generateId(),
          toolName: (block.name as string | undefined) ?? block.toolName ?? "unknown",
          args: block.input ?? block.args ?? {},
        });
      } else if (typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      }
    }

    if (parts.length === 0) {
      return { role: "assistant", content: "" };
    }
    return { role: "assistant", content: parts as CoreMessage["content"] };
  }

  return { role: "assistant", content: String(m.content ?? "") };
}

function convertToolMessage(m: AgentMessage): CoreMessage {
  if (!Array.isArray(m.content)) {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: generateId(),
          toolName: "unknown",
          result: String(m.content ?? ""),
        },
      ],
    };
  }

  const parts = m.content.map((block) => ({
    type: "tool-result" as const,
    toolCallId: block.toolCallId ?? (block.toolUseId as string | undefined) ?? generateId(),
    toolName: block.toolName ?? "unknown",
    result: block.result ?? block.content ?? block.text ?? "",
  }));

  return { role: "tool", content: parts };
}

function normalizeContentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String(part.text);
        }
        return "";
      })
      .join("");
  }
  if (typeof content === "string") {
    return content;
  }
  return "";
}

let _idCounter = 0;
function generateId(): string {
  return `mastra-${Date.now()}-${++_idCounter}`;
}
