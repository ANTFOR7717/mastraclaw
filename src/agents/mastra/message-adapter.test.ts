import { describe, expect, it } from "vitest";
import { toCoreMessages, fromCoreMessage } from "./message-adapter.js";

describe("toCoreMessages", () => {
  it("converts simple user text message", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = toCoreMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("converts simple assistant text message", () => {
    const messages = [{ role: "assistant", content: "Hi there" }];
    const result = toCoreMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("converts user message with image content", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      },
    ];
    const result = toCoreMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
    const content = result[0]?.content as Array<{ type: string }>;
    expect(content[0]).toEqual({ type: "text", text: "What is this?" });
    expect(content[1]).toMatchObject({ type: "image", image: "base64data", mimeType: "image/png" });
  });

  it("converts assistant message with tool call", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          {
            type: "toolCall",
            toolCallId: "call-1",
            name: "read_file",
            input: { path: "/tmp/test.txt" },
          },
        ],
      },
    ];
    const result = toCoreMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    const content = result[0]?.content as Array<{ type: string; toolName?: string }>;
    expect(content[0]).toEqual({ type: "text", text: "Let me read that file." });
    expect(content[1]).toMatchObject({ type: "tool-call", toolName: "read_file" });
  });

  it("converts tool result message", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            result: "file contents",
          },
        ],
      },
    ];
    const result = toCoreMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("tool");
    const content = result[0]?.content as Array<{ type: string; result: unknown }>;
    expect(content[0]).toMatchObject({ type: "tool-result", result: "file contents" });
  });

  it("skips unknown roles", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "system", content: "You are helpful" }, // system is handled separately
      { role: "user", content: "World" },
    ];
    const result = toCoreMessages(messages);
    // system role is skipped (handled as agent instructions)
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[1]?.role).toBe("user");
  });

  it("handles empty messages array", () => {
    expect(toCoreMessages([])).toEqual([]);
  });

  it("handles null/undefined entries gracefully", () => {
    const messages = [null, undefined, { role: "user", content: "Hello" }];
    const result = toCoreMessages(messages);
    expect(result).toHaveLength(1);
  });
});

describe("fromCoreMessage", () => {
  it("converts user CoreMessage back to AgentMessage", () => {
    const msg = { role: "user" as const, content: "Hello" };
    const result = fromCoreMessage(msg);
    expect(result).toEqual({ role: "user", content: "Hello" });
  });

  it("converts assistant CoreMessage back to AgentMessage", () => {
    const msg = { role: "assistant" as const, content: "Hi there" };
    const result = fromCoreMessage(msg);
    expect(result).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("returns null for system messages", () => {
    const msg = { role: "system" as const, content: "You are helpful" };
    const result = fromCoreMessage(msg);
    expect(result).toBeNull();
  });
});
