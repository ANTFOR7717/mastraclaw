/**
 * Tool adapter: AgentTool (TypeBox schema) → Mastra ToolAction (Zod schema).
 *
 * OpenClaw tools use TypeBox schemas; Mastra tools use Zod schemas.
 * This adapter converts between them using typeboxToZod().
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { typeboxToZod } from "./typebox-to-zod.js";

// We use a structural type for the Mastra tool to avoid requiring @mastra/core
// as a hard dep at import time. The shape matches createTool() output.
export type MastraToolLike = {
  id: string;
  description: string;
  inputSchema: unknown;
  execute: (params: { context: unknown }) => Promise<unknown>;
};

/**
 * Adapt a single pi-agent-core AgentTool to a Mastra-compatible tool object.
 *
 * The execute function delegates to the original tool.execute() so all existing
 * tool implementations (bash, read, write, etc.) work unchanged.
 */
export function adaptToolForMastra(tool: AgentTool): MastraToolLike {
  return {
    id: tool.name,
    description: tool.description ?? "",
    inputSchema: typeboxToZod(tool.parameters),
    execute: async ({ context }: { context: unknown }) => {
      const result = await tool.execute(context as Record<string, unknown>);
      // Normalize result to string for Mastra's tool result handling
      if (typeof result === "string") {
        return result;
      }
      if (result === undefined || result === null) {
        return "";
      }
      try {
        return JSON.stringify(result);
      } catch {
        return String(result);
      }
    },
  };
}

/**
 * Adapt an array of AgentTools to a Record<string, MastraToolLike> as expected
 * by the Mastra Agent constructor's `tools` parameter.
 */
export function adaptToolsForMastra(tools: AgentTool[]): Record<string, MastraToolLike> {
  const result: Record<string, MastraToolLike> = {};
  for (const tool of tools) {
    result[tool.name] = adaptToolForMastra(tool);
  }
  return result;
}
