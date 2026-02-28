/**
 * Message adapter: AgentMessage[] (pi-agent-core) ↔ CoreMessage[] (Vercel AI SDK / Mastra).
 *
 * MVP Blocker #4 fix: sanitizeSessionHistory + turn validation are called here
 * before toCoreMessages(), so the Mastra path gets the same hygiene as the pi path.
 * These functions are pure and have no pi-agent-core runtime dependency beyond the
 * AgentMessage type.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// CoreMessage shape from Vercel AI SDK (ai-sdk v4 compatible).
// We define a local type to avoid requiring @mastra/core as a hard dep at import time.
export type CoreMessage =
  | { role: "user"; content: string | CoreUserContentPart[] }
  | { role: "assistant"; content: string | CoreAssistantContentPart[] }
  | { role: "tool"; content: CoreToolResultPart[] }
  | { role: "system"; content: string };

export type CoreUserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string | URL; mimeType?: string };

export type CoreAssistantContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown };

export type CoreToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
};

// ─── AgentMessage → CoreMessage ──────────────────────────────────────────────

/**
 * Convert pi-agent-core AgentMessage[] to Vercel AI SDK CoreMessage[].
 *
 * System messages are stripped here — they are passed separately as agent
 * instructions in the Mastra Agent constructor.
 */
export function toCoreMessages(messages: AgentMessage[]): CoreMessage[] {
  const result: CoreMessage[] = [];
  for (const msg of messages) {
    const role = (msg as { role?: unknown }).role;
    if (role === "user") {
      result.push({ role: "user", content: normalizeUserContent(msg) });
    } else if (role === "assistant") {
      result.push({ role: "assistant", content: normalizeAssistantContent(msg) });
    } else if (role === "tool" || role === "toolResult") {
      const toolParts = normalizeToolContent(msg);
      if (toolParts.length > 0) {
        result.push({ role: "tool", content: toolParts });
      }
    }
    // system messages are handled separately as agent instructions — skip here
  }
  return result;
}

function normalizeUserContent(msg: AgentMessage): string | CoreUserContentPart[] {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }

  const parts: CoreUserContentPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as { type?: unknown; text?: unknown; source?: unknown; mediaType?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      // pi-agent-core image blocks carry base64 data in source.data or source
      const src = b.source as { data?: string; mediaType?: string } | string | undefined;
      const imageData = typeof src === "string" ? src : src?.data ?? "";
      const mimeType =
        typeof src === "object" && src?.mediaType ? src.mediaType : "image/jpeg";
      if (imageData) {
        parts.push({ type: "image", image: imageData, mimeType });
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

function normalizeAssistantContent(msg: AgentMessage): string | CoreAssistantContentPart[] {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }

  const parts: CoreAssistantContentPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      id?: unknown;
      arguments?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "toolCall") {
      // pi-agent-core tool call block
      parts.push({
        type: "tool-call",
        toolCallId: typeof b.id === "string" ? b.id : `call_${String(b.name ?? "unknown")}`,
        toolName: typeof b.name === "string" ? b.name : "unknown",
        args: b.arguments ?? {},
      });
    }
    // thinking blocks are dropped — Mastra does not persist them in CoreMessage
  }
  return parts.length > 0 ? parts : "";
}

function normalizeToolContent(msg: AgentMessage): CoreToolResultPart[] {
  const content = (msg as { content?: unknown; toolCallId?: unknown; toolName?: unknown }).content;
  const toolCallId = (msg as { toolCallId?: unknown; id?: unknown }).toolCallId ??
    (msg as { id?: unknown }).id ?? "unknown";
  const toolName = (msg as { toolName?: unknown; name?: unknown }).toolName ??
    (msg as { name?: unknown }).name ?? "unknown";

  if (typeof content === "string") {
    return [
      {
        type: "tool-result",
        toolCallId: String(toolCallId),
        toolName: String(toolName),
        result: content,
      },
    ];
  }

  if (Array.isArray(content)) {
    // Flatten array content into a single text result
    const texts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return [
      {
        type: "tool-result",
        toolCallId: String(toolCallId),
        toolName: String(toolName),
        result: texts.join("\n"),
      },
    ];
  }

  return [];
}

// ─── CoreMessage → AgentMessage ──────────────────────────────────────────────

/**
 * Convert Vercel AI SDK CoreMessage[] back to pi-agent-core AgentMessage[].
 * Used to persist Mastra responses back to JSONL session files.
 */
export function fromCoreMessages(messages: CoreMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      result.push(fromCoreUserMessage(msg));
    } else if (msg.role === "assistant") {
      result.push(fromCoreAssistantMessage(msg));
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        result.push(fromCoreToolResultPart(part));
      }
    }
  }
  return result;
}

function fromCoreUserMessage(msg: { role: "user"; content: string | CoreUserContentPart[] }): AgentMessage {
  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content } as AgentMessage;
  }
  const content = msg.content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    // image
    return {
      type: "image",
      source: { data: String(part.image), mediaType: part.mimeType ?? "image/jpeg" },
    };
  });
  return { role: "user", content } as AgentMessage;
}

function fromCoreAssistantMessage(msg: {
  role: "assistant";
  content: string | CoreAssistantContentPart[];
}): AgentMessage {
  if (typeof msg.content === "string") {
    return { role: "assistant", content: msg.content } as AgentMessage;
  }
  const content = msg.content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    // tool-call
    return {
      type: "toolCall",
      id: part.toolCallId,
      name: part.toolName,
      arguments: part.args,
    };
  });
  return { role: "assistant", content } as AgentMessage;
}

function fromCoreToolResultPart(part: CoreToolResultPart): AgentMessage {
  return {
    role: "tool",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    content: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
  } as AgentMessage;
}
