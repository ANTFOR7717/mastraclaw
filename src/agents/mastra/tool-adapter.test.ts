import { describe, expect, it, vi } from "vitest";
import { adaptToolForMastra, adaptToolsForMastra } from "./tool-adapter.js";

describe("adaptToolForMastra", () => {
  it("creates a Mastra tool with correct id and description", () => {
    const tool = {
      name: "read_file",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: vi.fn().mockResolvedValue("file contents"),
    };

    const mastraTool = adaptToolForMastra(tool);
    expect(mastraTool.id).toBe("read_file");
    expect(mastraTool.description).toBe("Read a file from disk");
  });

  it("executes the underlying tool and returns string result", async () => {
    const tool = {
      name: "echo",
      description: "Echo input",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: vi.fn().mockResolvedValue("echoed text"),
    };

    const mastraTool = adaptToolForMastra(tool);
    const result = await mastraTool.execute?.({ context: { text: "hello" } } as Parameters<
      NonNullable<typeof mastraTool.execute>
    >[0]);
    expect(result).toBe("echoed text");
    // Verify the underlying tool was called once
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("normalizes array tool results to string", async () => {
    const tool = {
      name: "list",
      description: "List items",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue([
        { type: "text", text: "item 1" },
        { type: "text", text: "item 2" },
      ]),
    };

    const mastraTool = adaptToolForMastra(tool);
    const result = await mastraTool.execute?.({ context: {} } as Parameters<
      NonNullable<typeof mastraTool.execute>
    >[0]);
    expect(result).toBe("item 1\nitem 2");
  });

  it("returns error string when tool throws", async () => {
    const tool = {
      name: "failing_tool",
      description: "Always fails",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("tool error")),
    };

    const mastraTool = adaptToolForMastra(tool);
    const result = await mastraTool.execute?.({ context: {} } as Parameters<
      NonNullable<typeof mastraTool.execute>
    >[0]);
    expect(result).toBe("Error: tool error");
  });

  it("uses tool name as description when description is missing", () => {
    const tool = {
      name: "my_tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn().mockResolvedValue("ok"),
    };

    const mastraTool = adaptToolForMastra(tool);
    expect(mastraTool.description).toBe("my_tool");
  });
});

describe("adaptToolsForMastra", () => {
  it("converts an array of tools to a record", () => {
    const tools = [
      {
        name: "tool_a",
        description: "Tool A",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue("a"),
      },
      {
        name: "tool_b",
        description: "Tool B",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue("b"),
      },
    ];

    const result = adaptToolsForMastra(tools);
    expect(Object.keys(result)).toEqual(["tool_a", "tool_b"]);
    expect(result["tool_a"]?.id).toBe("tool_a");
    expect(result["tool_b"]?.id).toBe("tool_b");
  });

  it("skips tools with missing names", () => {
    const tools = [
      { name: "", description: "No name", parameters: {}, execute: vi.fn() },
      {
        name: "valid_tool",
        description: "Valid",
        parameters: {},
        execute: vi.fn().mockResolvedValue("ok"),
      },
    ];

    const result = adaptToolsForMastra(tools);
    expect(Object.keys(result)).toEqual(["valid_tool"]);
  });
});
