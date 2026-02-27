/**
 * Adapts OpenClaw AgentTool (pi-agent-core, TypeBox schemas) to
 * Mastra ToolAction (Zod schemas).
 *
 * OpenClaw tools have:
 *   - name: string
 *   - description: string
 *   - parameters: TSchema (TypeBox)
 *   - execute: (input, context) => Promise<AgentToolResult>
 *
 * Mastra tools have:
 *   - id: string
 *   - description: string
 *   - inputSchema: ZodSchema
 *   - execute: ({ context }) => Promise<string | object>
 */

import { createTool } from "@mastra/core/tools";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { typeboxToZod } from "./typebox-to-zod.js";

const log = createSubsystemLogger("mastra/tool-adapter");

type AgentToolResult =
  | string
  | { type: "text"; text: string }
  | Array<{ type: string; text?: string; [key: string]: unknown }>;

type AgentTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (input: unknown, context?: unknown) => Promise<AgentToolResult>;
};

/**
 * Adapt a single pi-agent-core AgentTool to a Mastra ToolAction.
 */
export function adaptToolForMastra(tool: AgentTool): ReturnType<typeof createTool> {
  const inputSchema = typeboxToZod(tool.parameters ?? { type: "object", properties: {} });

  return createTool({
    id: tool.name,
    description: tool.description ?? tool.name,
    inputSchema,
    execute: async ({ context }) => {
      try {
        const result = await tool.execute(context, undefined);
        return normalizeToolResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`tool ${tool.name} failed: ${message}`);
        return `Error: ${message}`;
      }
    },
  });
}

/**
 * Adapt an array of AgentTools to a Mastra tools record.
 */
export function adaptToolsForMastra(
  tools: AgentTool[],
): Record<string, ReturnType<typeof createTool>> {
  const result: Record<string, ReturnType<typeof createTool>> = {};
  for (const tool of tools) {
    if (!tool.name || typeof tool.name !== "string") {
      continue;
    }
    result[tool.name] = adaptToolForMastra(tool);
  }
  return result;
}

/**
 * Normalize a pi-agent-core tool result to a string or object
 * that Mastra can serialize.
 */
function normalizeToolResult(result: AgentToolResult): string | object {
  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result)) {
    // Extract text from content blocks
    const texts = result
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .filter(Boolean);
    return texts.join("\n");
  }

  if (result && typeof result === "object") {
    if ("text" in result && typeof result.text === "string") {
      return result.text;
    }
    return result;
  }

  return String(result ?? "");
}
