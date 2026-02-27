/**
 * Compaction adapter for the Mastra gateway path.
 *
 * Replaces pi-coding-agent's generateSummary and estimateTokens with
 * Mastra-native equivalents.
 *
 * generateSummary: uses agent.generate() with a summarization prompt
 * estimateTokens: character-based estimate (~4 chars per token)
 */

import { Agent } from "@mastra/core/agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { toCoreMessages } from "./message-adapter.js";
import type { MastraModelConfig } from "./model-config.js";

const log = createSubsystemLogger("mastra/compaction");

/** Approximate tokens from character count (GPT-4 average: ~4 chars/token). */
export function mastraEstimateTokens(text: string): number {
  if (!text || typeof text !== "string") {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

/**
 * Generate a summary of the conversation history using the Mastra agent.
 * Replaces pi-coding-agent's generateSummary.
 */
export async function mastraGenerateSummary(params: {
  messages: unknown[];
  modelConfig: MastraModelConfig;
  systemPrompt: string;
  agentId?: string;
}): Promise<string> {
  const { messages, modelConfig, systemPrompt, agentId } = params;

  const agent = new Agent({
    id: agentId ?? "openclaw-compaction",
    name: "OpenClaw Compaction Agent",
    instructions: systemPrompt,
    model: modelConfig as Parameters<typeof Agent>[0]["model"],
    tools: {},
  });

  const coreMessages = toCoreMessages(messages);
  if (coreMessages.length === 0) {
    return "";
  }

  try {
    const result = await agent.generate(coreMessages);
    return result.text ?? "";
  } catch (err) {
    log.warn(`compaction summary generation failed: ${String(err)}`);
    throw err;
  }
}
