/**
 * Mastra gateway adapter — public exports.
 *
 * This module provides the Mastra-powered LLM execution path for OpenClaw.
 * It is activated when agents.defaults.gateway = "mastra" in the config.
 *
 * The adapter layer:
 *   - Preserves existing JSONL session files (no migration needed)
 *   - Supports all 8 ModelApi types via OpenAICompatibleConfig or native @ai-sdk/* packages
 *   - Emits the same streaming events as the pi-coding-agent path
 *   - Handles thinking/reasoning via providerOptions
 */

export { runMastraAgent } from "./agent-runner.js";
export { mastraEstimateTokens, mastraGenerateSummary } from "./compaction.js";
export { toCoreMessages, fromCoreMessage } from "./message-adapter.js";
export { toMastraModelConfig, toMastraProviderOptions } from "./model-config.js";
export { readSessionMessages, appendMastraMessages } from "./session-manager-compat.js";
export { adaptToolForMastra, adaptToolsForMastra } from "./tool-adapter.js";
export { typeboxToZod } from "./typebox-to-zod.js";
export type { MastraRunResult, MastraAgentRunParams, MastraModelParams } from "./types.js";
