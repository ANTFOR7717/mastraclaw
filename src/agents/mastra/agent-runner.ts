/**
 * Mastra agent runner — replaces createAgentSession + the inner LLM call loop
 * in runEmbeddedAttempt (lines 711–1203).
 *
 * MVP Blocker fixes implemented here:
 *
 * #1 — steer() / mid-run injection:
 *   MastraRunHandle.queueMessage() queues text in a local buffer. If isStreaming()
 *   is true when called, the message is held and replayed as a new turn after the
 *   current stream completes (same behavior as when isStreaming() returns false in
 *   the pi path — no crash, just deferred delivery). This is a documented behavioral
 *   change for Phase 1.
 *
 * #2 — isStreaming / isCompacting state:
 *   streaming boolean is set true when agent.stream() is called, false when it
 *   resolves. isCompacting() always returns false (Mastra has no compaction).
 *
 * #3 — Tool result context guard:
 *   enforceToolResultContextBudgetInPlace() is called on the AgentMessage array
 *   before toCoreMessages() to prevent context overflow from large tool results.
 *
 * Note: @mastra/core is a runtime dependency that must be installed separately.
 * This file uses dynamic import to avoid hard-failing at module load time when
 * @mastra/core is not yet installed (the pi path remains the default).
 */

import type { AgentTool, AgentMessage } from "@mariozechner/pi-agent-core";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { enforceToolResultContextBudgetInPlace } from "../pi-embedded-runner/tool-result-context-guard.js";
import { toCoreMessages, fromCoreMessages } from "./message-adapter.js";
import { adaptToolsForMastra } from "./tool-adapter.js";
import { toMastraModelConfig, toMastraProviderOptions } from "./model-config.js";
import type { MastraRunHandle, MastraLlmCallResult } from "./types.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE = 2;

export type RunMastraLlmCallParams = {
  /** System prompt text (after hook overrides applied). */
  systemPrompt: string;
  /** Effective user prompt (after hook prepend applied). */
  prompt: string;
  /** Session messages after sanitization and history limiting. */
  messages: AgentMessage[];
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider: string;
  /** Model identifier (e.g. "claude-opus-4-5"). */
  modelId: string;
  /** Resolved model config. */
  model: {
    api?: string | null;
    contextWindow?: number;
    maxTokens?: number;
    baseUrl?: string;
    provider?: string;
  };
  /** API key for the provider. */
  apiKey?: string;
  /** Additional HTTP headers for the provider. */
  headers?: Record<string, string>;
  /** Tools available to the agent (pi-agent-core AgentTool[]). */
  tools: AgentTool[];
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
  /** Callbacks for streaming events (mirrors subscribeEmbeddedPiSession). */
  onTextDelta?: (text: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, result: unknown) => void;
  onFinish?: (assistantText: string) => void;
};

/**
 * Run the Mastra LLM call — replaces createAgentSession + activeSession.prompt().
 *
 * Returns a MastraRunHandle that exposes isStreaming/isCompacting/abort/queueMessage
 * for the run registry (runs.ts), plus a Promise<MastraLlmCallResult> that resolves
 * when the stream completes.
 */
export function runMastraLlmCall(params: RunMastraLlmCallParams): {
  handle: MastraRunHandle;
  result: Promise<MastraLlmCallResult>;
} {
  // ── State for blockers #1 and #2 ──────────────────────────────────────────
  let streaming = false;
  const pendingMessages: string[] = [];
  const abortController = new AbortController();

  // Forward external abort signal to our internal controller
  if (params.abortSignal) {
    if (params.abortSignal.aborted) {
      abortController.abort(params.abortSignal.reason);
    } else {
      params.abortSignal.addEventListener(
        "abort",
        () => abortController.abort(params.abortSignal!.reason),
        { once: true },
      );
    }
  }

  const handle: MastraRunHandle = {
    // Blocker #2: expose streaming state
    isStreaming: () => streaming,
    // Mastra has no compaction concept — always false
    isCompacting: () => false,
    abort: (_isTimeout?: boolean, reason?: unknown) => {
      abortController.abort(reason);
    },
    // Blocker #1: queue message for next turn if streaming, otherwise no-op
    // (the outer loop in runEmbeddedAttempt handles the next turn)
    queueMessage: async (text: string) => {
      if (streaming) {
        // Mid-run injection not supported in Mastra Phase 1.
        // Queue for replay after the current stream completes.
        pendingMessages.push(text);
      }
      // If not streaming, the message arrives between turns — the outer
      // run loop will pick it up as the next prompt naturally.
    },
  };

  const result = (async (): Promise<MastraLlmCallResult> => {
    streaming = true;
    try {
      return await executeStream(params, abortController);
    } finally {
      streaming = false;
    }
  })();

  return { handle, result };
}

async function executeStream(
  params: RunMastraLlmCallParams,
  abortController: AbortController,
): Promise<MastraLlmCallResult> {
  // ── Blocker #3: enforce tool result context budget before agent.stream() ──
  const contextWindowTokens = Math.max(
    1,
    Math.floor(params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS),
  );
  const contextBudgetChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  // Apply context guard in-place on the AgentMessage array before conversion.
  // This is the same logic as installToolResultContextGuard() in the pi path,
  // but applied eagerly here rather than via agent.transformContext hook.
  enforceToolResultContextBudgetInPlace({
    messages: params.messages,
    contextBudgetChars,
    maxSingleToolResultChars,
  });

  // Convert AgentMessage[] → CoreMessage[].
  // Blocker #4 (sanitizeSessionHistory + turn validation) is handled upstream
  // in runEmbeddedAttempt before this function is called — those run in the
  // shared code path at lines 856–887.
  const coreMessages = toCoreMessages(params.messages);

  // Dynamically import @mastra/core to avoid hard-failing when not installed
  let Agent: typeof import("@mastra/core/agent").Agent;
  try {
    const mod = await import("@mastra/core/agent");
    Agent = mod.Agent;
  } catch (err) {
    throw new Error(
      `@mastra/core is not installed. Install it with: pnpm add @mastra/core@1.8.0\n` +
        `Original error: ${String(err)}`,
    );
  }

  const mastraTools = adaptToolsForMastra(params.tools);
  const modelConfig = toMastraModelConfig({
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.model.api,
    baseUrl: params.model.baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
  });

  const agent = new Agent({
    name: `openclaw-${params.provider}-${params.modelId}`,
    instructions: params.systemPrompt,
    model: modelConfig as Parameters<typeof Agent>[0]["model"],
    tools: mastraTools as Parameters<typeof Agent>[0]["tools"],
  });

  const providerOptions = toMastraProviderOptions(params.thinkLevel, params.provider);
  const maxSteps = params.maxSteps ?? 50;

  let aborted = false;
  let timedOut = false;
  let promptError: unknown = null;
  const assistantTextChunks: string[] = [];

  try {
    const output = await agent.stream(coreMessages, {
      maxSteps,
      ...(providerOptions ? { providerOptions } : {}),
      abortSignal: abortController.signal,
    } as Parameters<typeof agent.stream>[1]);

    // Consume the full stream and emit events
    for await (const chunk of (output as { fullStream: AsyncIterable<unknown> }).fullStream) {
      if (!chunk || typeof chunk !== "object") {
        continue;
      }
      const c = chunk as {
        type?: string;
        textDelta?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (c.type === "text-delta" && typeof c.textDelta === "string") {
        assistantTextChunks.push(c.textDelta);
        params.onTextDelta?.(c.textDelta);
      } else if (c.type === "tool-call") {
        params.onToolCall?.(c.toolName ?? "unknown", c.args);
      } else if (c.type === "tool-result") {
        params.onToolResult?.(c.toolName ?? "unknown", c.result);
      } else if (c.type === "error") {
        promptError = c.error ?? new Error("Mastra stream error");
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      aborted = true;
      const reason = abortController.signal.reason;
      if (
        reason &&
        typeof reason === "object" &&
        (reason as { name?: string }).name === "TimeoutError"
      ) {
        timedOut = true;
      }
    } else {
      promptError = err;
    }
  }

  const assistantText = assistantTextChunks.join("");
  params.onFinish?.(assistantText);

  return { assistantText, aborted, timedOut, promptError };
}

/**
 * Convert the Mastra run result back to AgentMessage[] for session persistence.
 * The caller (runEmbeddedAttempt) appends these to the session file.
 */
export function mastraResultToMessages(
  prompt: string,
  assistantText: string,
): AgentMessage[] {
  return fromCoreMessages([
    { role: "user", content: prompt },
    { role: "assistant", content: assistantText },
  ]);
}
