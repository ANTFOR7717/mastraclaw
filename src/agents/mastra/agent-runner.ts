/**
 * Mastra agent runner — the core LLM execution loop.
 *
 * Replaces pi-coding-agent's createAgentSession + the inner agent loop
 * in src/agents/pi-embedded-runner/run/attempt.ts.
 *
 * This runner:
 *   1. Reads existing session history from the JSONL session file
 *   2. Converts history to CoreMessage[] for Mastra
 *   3. Creates a Mastra Agent with the resolved model config and tools
 *   4. Streams the response, emitting text deltas and tool events
 *   5. Appends new messages back to the JSONL session file
 */

import { Agent } from "@mastra/core/agent";
import type { CoreMessage } from "@mastra/core/llm";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { toCoreMessages } from "./message-adapter.js";
import { toMastraModelConfig, toMastraProviderOptions } from "./model-config.js";
import { readSessionMessages, appendMastraMessages } from "./session-manager-compat.js";
import { adaptToolsForMastra } from "./tool-adapter.js";
import type { MastraAgentRunParams, MastraRunResult } from "./types.js";

const log = createSubsystemLogger("mastra/agent-runner");

/** Default max tool loop steps — matches typical pi-coding-agent behavior. */
const DEFAULT_MAX_STEPS = 50;

/**
 * Run the Mastra agent for a single prompt turn.
 *
 * This is the main entry point called from runEmbeddedAttempt when
 * agents.gateway = "mastra".
 */
export async function runMastraAgent(
  params: MastraAgentRunParams & { sessionFile: string },
): Promise<MastraRunResult> {
  const {
    provider,
    modelId,
    modelApi,
    baseUrl,
    apiKey,
    headers,
    systemPrompt,
    prompt,
    images,
    tools: rawTools,
    thinkLevel,
    maxSteps = DEFAULT_MAX_STEPS,
    abortSignal,
    onTextDelta,
    onToolCall,
    onToolResult,
    sessionFile,
  } = params;

  let aborted = false;
  let timedOut = false;
  let runError: unknown;

  // Track abort signal
  if (abortSignal?.aborted) {
    return {
      text: "",
      aborted: true,
      timedOut: false,
      toolCalls: [],
      toolResults: [],
    };
  }

  const onAbort = () => {
    aborted = true;
    const reason = (abortSignal as { reason?: unknown } | undefined)?.reason;
    if (reason instanceof Error && reason.name === "TimeoutError") {
      timedOut = true;
    }
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    // 1. Resolve model config (async for Google/Bedrock native SDK)
    const modelConfig = await toMastraModelConfig({
      provider,
      modelId,
      modelApi,
      baseUrl,
      apiKey,
      headers,
    });

    // 2. Read existing session history from JSONL file
    const historyMessages = await readSessionMessages(sessionFile);
    const historyCoreMessages = toCoreMessages(historyMessages);

    // 3. Build the new user message (with optional images)
    const newUserMessage: CoreMessage = buildUserMessage(prompt, images);

    // 4. Combine history + new message
    const allMessages: CoreMessage[] = [...historyCoreMessages, newUserMessage];

    // 5. Adapt tools
    const mastraTools = adaptToolsForMastra(rawTools as Parameters<typeof adaptToolsForMastra>[0]);

    // 6. Resolve provider options (thinking/reasoning)
    const providerOptions = toMastraProviderOptions(thinkLevel, provider, modelApi);

    // 7. Create Mastra Agent
    const agent = new Agent({
      id: `openclaw-${provider}-${modelId}`,
      name: "OpenClaw Agent",
      instructions: systemPrompt,
      model: modelConfig as Parameters<typeof Agent>[0]["model"],
      tools: mastraTools,
    });

    log.debug(
      `mastra run start: provider=${provider} model=${modelId} steps=${maxSteps} tools=${Object.keys(mastraTools).length}`,
    );

    // 8. Stream the response
    const streamOptions: Record<string, unknown> = { maxSteps };
    if (providerOptions) {
      streamOptions.providerOptions = providerOptions;
    }
    if (abortSignal) {
      streamOptions.abortSignal = abortSignal;
    }

    const output = await agent.stream(
      allMessages,
      streamOptions as Parameters<typeof agent.stream>[1],
    );

    // 9. Consume the stream and emit events
    const toolCallsCollected: Array<{ toolName: string; args: unknown }> = [];
    const toolResultsCollected: Array<{ toolName: string; result: unknown }> = [];
    let finalText = "";

    for await (const chunk of output.fullStream) {
      if (aborted) {
        break;
      }

      const c = chunk as {
        type: string;
        textDelta?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
      };

      if (c.type === "text-delta" && typeof c.textDelta === "string") {
        finalText += c.textDelta;
        onTextDelta?.(c.textDelta);
      } else if (c.type === "tool-call" && typeof c.toolName === "string") {
        toolCallsCollected.push({ toolName: c.toolName, args: c.args });
        onToolCall?.(c.toolName, c.args);
      } else if (c.type === "tool-result" && typeof c.toolName === "string") {
        toolResultsCollected.push({ toolName: c.toolName, result: c.result });
        onToolResult?.(c.toolName, c.result);
      }
    }

    // 10. Append new messages to the JSONL session file
    const newMessages: CoreMessage[] = [newUserMessage, { role: "assistant", content: finalText }];
    await appendMastraMessages(sessionFile, newMessages);

    log.debug(
      `mastra run end: provider=${provider} model=${modelId} textLen=${finalText.length} toolCalls=${toolCallsCollected.length}`,
    );

    return {
      text: finalText,
      aborted,
      timedOut,
      toolCalls: toolCallsCollected,
      toolResults: toolResultsCollected,
    };
  } catch (err) {
    runError = err;
    if (!aborted) {
      log.warn(`mastra run error: provider=${provider} model=${modelId} error=${String(err)}`);
    }
    return {
      text: "",
      aborted,
      timedOut,
      error: runError,
      toolCalls: [],
      toolResults: [],
    };
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Build a CoreMessage for the user prompt, optionally including images.
 */
function buildUserMessage(
  prompt: string,
  images?: Array<{ data: string; mimeType: string }>,
): CoreMessage {
  if (!images || images.length === 0) {
    return { role: "user", content: prompt };
  }

  const parts: Array<
    { type: "text"; text: string } | { type: "image"; image: string; mimeType: string }
  > = [
    { type: "text", text: prompt },
    ...images.map((img) => ({
      type: "image" as const,
      image: img.data,
      mimeType: img.mimeType,
    })),
  ];

  return { role: "user", content: parts };
}
