/**
 * Public re-exports for the Mastra gateway adapter layer.
 *
 * Import from this module to use the Mastra path in runEmbeddedAttempt.
 */

export type { MastraRunHandle, MastraLlmCallResult, MastraLlmCallParams } from "./types.js";
export { runMastraLlmCall, mastraResultToMessages, type RunMastraLlmCallParams } from "./agent-runner.js";
export { toCoreMessages, fromCoreMessages, type CoreMessage } from "./message-adapter.js";
export { adaptToolForMastra, adaptToolsForMastra } from "./tool-adapter.js";
export { typeboxToZod } from "./typebox-to-zod.js";
export { toMastraModelConfig, toMastraProviderOptions } from "./model-config.js";
