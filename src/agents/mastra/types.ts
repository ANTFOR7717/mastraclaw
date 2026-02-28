/**
 * Internal types for the Mastra gateway adapter layer.
 *
 * These types mirror the contracts used by the pi-coding-agent path so that
 * the surrounding infrastructure in runEmbeddedAttempt can remain unchanged.
 */

/**
 * Handle exposed to the run registry (runs.ts) for the Mastra execution path.
 *
 * Mirrors EmbeddedPiQueueHandle from the pi path:
 * - isStreaming(): true while agent.stream() is in flight
 * - isCompacting(): always false (Mastra has no compaction concept)
 * - queueMessage(): queues text for the next turn (mid-run injection not supported;
 *   message is held and replayed after the current stream completes)
 * - abort(): cancels the current stream via AbortController
 */
export type MastraRunHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: (isTimeout?: boolean, reason?: unknown) => void;
};

/**
 * Result returned by runMastraLlmCall after the agent stream completes.
 */
export type MastraLlmCallResult = {
  /** All assistant text chunks concatenated. */
  assistantText: string;
  /** Whether the run was aborted before completion. */
  aborted: boolean;
  /** Whether the run timed out. */
  timedOut: boolean;
  /** Error thrown during the stream, if any. */
  promptError: unknown;
};

/**
 * Parameters passed to runMastraLlmCall — the subset of EmbeddedRunAttemptParams
 * needed at the LLM call site (after all shared setup has run).
 */
export type MastraLlmCallParams = {
  /** System prompt text (after hook overrides applied). */
  systemPrompt: string;
  /** Effective user prompt (after hook prepend applied). */
  prompt: string;
  /** Session messages after sanitization and history limiting. */
  messages: unknown[];
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider: string;
  /** Model identifier (e.g. "claude-opus-4-5"). */
  modelId: string;
  /** Resolved model config (for context window, api type, etc.). */
  model: {
    api?: string | null;
    contextWindow?: number;
    maxTokens?: number;
    baseUrl?: string;
    provider?: string;
  };
  /** API key for the provider. */
  apiKey?: string;
  /** Tools available to the agent. */
  tools: unknown[];
  /** Thinking level for reasoning-capable models. */
  thinkLevel?: string;
  /** Max steps for the agent loop (default: 50). */
  maxSteps?: number;
  /** Abort signal from the outer run controller. */
  abortSignal?: AbortSignal;
  /** Images to inject into the prompt (vision models). */
  images?: unknown[];
  /** Run ID for logging. */
  runId: string;
  /** Session ID for logging. */
  sessionId: string;
  /** Config for maxSteps resolution. */
  config?: {
    agents?: {
      defaults?: {
        maxSteps?: number;
      };
    };
  };
};
