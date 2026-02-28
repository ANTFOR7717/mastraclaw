# Audit 3: Mastra Gateway Integration — Comprehensive Issue Analysis

**Audited plan:** [`plans/mastra-gateway-integration.md`](plans/mastra-gateway-integration.md)
**Prior audits:** Audit 1 (7 blockers identified), Audit 2 (7 blockers resolved in plan)
**Audit date:** 2026-02-28
**Scope:** Deep analysis of the existing pi-coding-agent execution pattern vs the proposed Mastra integration, identifying ALL potential issues beyond the 7 blockers already addressed.

---

## Methodology

This audit reads the actual source code of the existing pi execution path and compares it against the Mastra plan's proposed adapter layer. Every feature of the existing path is catalogued and checked against what the Mastra path must provide.

**Key files analyzed:**
- [`src/agents/pi-embedded-runner/run/attempt.ts`](src/agents/pi-embedded-runner/run/attempt.ts) — main execution loop (1438 lines)
- [`src/agents/pi-embedded-subscribe.ts`](src/agents/pi-embedded-subscribe.ts) — session event subscription
- [`src/agents/pi-embedded-subscribe.types.ts`](src/agents/pi-embedded-subscribe.types.ts) — subscription contract
- [`src/agents/pi-embedded-subscribe.handlers.ts`](src/agents/pi-embedded-subscribe.handlers.ts) — event handlers
- [`src/agents/pi-embedded-runner/run/types.ts`](src/agents/pi-embedded-runner/run/types.ts) — result types
- [`src/agents/pi-embedded-runner/extensions.ts`](src/agents/pi-embedded-runner/extensions.ts) — extension factories
- [`src/agents/pi-embedded-runner/extra-params.ts`](src/agents/pi-embedded-runner/extra-params.ts) — provider-specific params
- [`src/agents/pi-embedded-runner/runs.ts`](src/agents/pi-embedded-runner/runs.ts) — queue handle
- [`src/agents/model-auth.ts`](src/agents/model-auth.ts) — auth resolution

---

## Issue 1 — `EmbeddedPiQueueHandle.queueMessage` / `steer()` Has No Mastra Equivalent

### Severity: **Critical**

### What the pi path does

[`src/agents/pi-embedded-runner/runs.ts:7-12`](src/agents/pi-embedded-runner/runs.ts:7):

```typescript
type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};
```

[`src/agents/pi-embedded-runner/run/attempt.ts:988-995`](src/agents/pi-embedded-runner/run/attempt.ts:988):

```typescript
const queueHandle: EmbeddedPiQueueHandle = {
  queueMessage: async (text: string) => {
    await activeSession.steer(text);  // mid-run message injection
  },
  isStreaming: () => activeSession.isStreaming,
  isCompacting: () => subscription.isCompacting(),
  abort: abortRun,
};
setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
```

`queueEmbeddedPiMessage()` in `runs.ts` is called by the gateway when a new message arrives while an agent is already running. It calls `activeSession.steer(text)` to inject the message mid-run without interrupting the current tool loop.

### What Mastra provides

Mastra's `Agent.stream()` returns a `ReadableStream`. There is no `steer()` equivalent — no way to inject a message into an in-progress stream.

### Impact

- Mid-run message injection (used when a user sends a follow-up while the agent is still processing) will silently fail in the Mastra path
- `queueEmbeddedPiMessage()` will return `false` (no active run) or the message will be dropped
- The plan does not address this at all

### Resolution required

The plan must specify one of:
1. **Option A (Phase 1):** `queueHandle.queueMessage` in the Mastra path buffers the message and delivers it as a new prompt after the current stream completes
2. **Option B (Phase 1):** `queueHandle.queueMessage` aborts the current stream and restarts with the new message appended
3. **Option C (document limitation):** Document that mid-run message injection is not supported with `gateway = "mastra"` and `queueEmbeddedPiMessage()` returns `false` for Mastra runs

---

## Issue 2 — `isStreaming` / `isCompacting` State Tracking Has No Mastra Equivalent

### Severity: **Critical**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:992-993`](src/agents/pi-embedded-runner/run/attempt.ts:992):

```typescript
isStreaming: () => activeSession.isStreaming,
isCompacting: () => subscription.isCompacting(),
```

These are used by:
- `queueEmbeddedPiMessage()` — blocks message injection during compaction
- `abortEmbeddedPiRun()` — checks if run is active
- `isEmbeddedPiRunStreaming()` — used by gateway to check run state
- Timeout handler at line 1019: `if (!activeSession.isStreaming) { return; }`

### What Mastra provides

Mastra's `Agent.stream()` is a one-shot async operation. There is no `isStreaming` property on the agent. The Mastra path must track streaming state manually.

### Impact

- `isEmbeddedPiRunStreaming()` will always return `false` for Mastra runs
- The abort warn timer (line 1019) will fire immediately instead of waiting for streaming to stop
- Gateway-level run state tracking will be incorrect

### Resolution required

The `subscribeMastraSession()` implementation must expose `isStreaming()` and `isCompacting()` methods that track the state of the current `agent.stream()` call. The `queueHandle` for Mastra runs must use these instead of `activeSession.isStreaming`.

---

## Issue 3 — `streamFn` Wrapping Pipeline Has No Mastra Equivalent

### Severity: **High**

### What the pi path does

The pi path wraps `activeSession.agent.streamFn` with multiple layers:

1. **Ollama native API** (line 770): `activeSession.agent.streamFn = createOllamaStreamFn(ollamaBaseUrl)`
2. **`dropThinkingBlocks`** (line 800): Strips thinking blocks from outbound requests for providers that reject them
3. **`sanitizeToolCallIds`** (line 826): Normalizes tool call IDs for strict providers (Mistral, etc.)
4. **`wrapStreamFnTrimToolCallNames`** (line 847): Trims whitespace from tool call names
5. **`cacheTrace.wrapStreamFn`** (line 792): Cache tracing
6. **`anthropicPayloadLogger.wrapStreamFn`** (line 850): Payload logging

Each wrapper intercepts every outbound LLM request and applies provider-specific sanitization.

### What Mastra provides

Mastra's `Agent.stream()` does not expose a `streamFn` wrapping mechanism. The `fullStream` is consumed after the fact — there is no pre-request hook.

### Impact

- **Thinking block stripping** (`dropThinkingBlocks`): Providers like GitHub Copilot and Claude reject persisted `thinking` blocks in follow-up requests. Without this wrapper, the Mastra path will fail on multi-turn conversations with thinking-enabled models.
- **Tool call ID sanitization**: Mistral and other strict providers reject tool call IDs that don't match their format. Without sanitization, tool calls will fail on these providers.
- **Tool call name trimming**: Some models emit tool names with surrounding whitespace. Without trimming, tool dispatch will fail.
- **Ollama native API**: The plan mentions `OpenAICompatibleConfig` for Ollama, but the pi path uses a custom native API client (`createOllamaStreamFn`) for reliable streaming + tool calling. The Mastra path may have different Ollama behavior.

### Resolution required

The plan must specify how each of these transformations is applied in the Mastra path:
- `dropThinkingBlocks`: Apply to `CoreMessage[]` before passing to `agent.stream()`
- `sanitizeToolCallIds`: Apply to `CoreMessage[]` before passing to `agent.stream()`
- `wrapStreamFnTrimToolCallNames`: Apply to tool call names in the `fullStream` consumer
- Ollama: Verify Mastra's `OpenAICompatibleConfig` with Ollama base URL provides equivalent behavior to `createOllamaStreamFn`

---

## Issue 4 — `applyExtraParamsToAgent` Has No Mastra Equivalent

### Severity: **High**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:776-784`](src/agents/pi-embedded-runner/run/attempt.ts:776):

```typescript
applyExtraParamsToAgent(
  activeSession.agent,
  params.config,
  params.provider,
  params.modelId,
  params.streamParams,
  params.thinkLevel,
  sessionAgentId,
);
```

`applyExtraParamsToAgent` in [`src/agents/pi-embedded-runner/extra-params.ts`](src/agents/pi-embedded-runner/extra-params.ts) applies:
- `temperature` from `agents.defaults.models.<provider>/<model>.params.temperature`
- `maxTokens` from `agents.defaults.models.<provider>/<model>.params.maxTokens`
- `transport` (SSE/WebSocket/auto)
- `cacheRetention` (Anthropic prompt caching: "none"/"short"/"long")
- OpenRouter provider routing (`params.provider` object)
- Anthropic 1M context beta header for Claude Opus 4 / Sonnet 4
- OpenAI Responses API `store=true` flag

### What Mastra provides

Mastra's `agent.stream()` accepts `providerOptions` for provider-specific params. However:
- `temperature` and `maxTokens` are standard and supported
- `cacheRetention` (Anthropic prompt caching) requires `@ai-sdk/anthropic`-specific `cacheControl` markers on messages — not a simple stream option
- OpenRouter provider routing requires custom headers
- Anthropic 1M context beta requires `anthropic-beta: context-1m-2025-08-07` header
- OpenAI Responses `store=true` requires a specific request body field

### Impact

- Users with `agents.defaults.models.<provider>/<model>.params` configured will silently get default behavior
- Anthropic prompt caching will not work (significant cost impact for heavy users)
- OpenRouter provider routing will not work
- Anthropic 1M context window will not be available for Claude Opus 4 / Sonnet 4

### Resolution required

The plan must specify how `resolveExtraParams()` output is mapped to Mastra's `providerOptions` and `@ai-sdk/anthropic` cache control markers.

---

## Issue 5 — `installToolResultContextGuard` Has No Mastra Equivalent

### Severity: **High**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:729-737`](src/agents/pi-embedded-runner/run/attempt.ts:729):

```typescript
removeToolResultContextGuard = installToolResultContextGuard({
  agent: activeSession.agent,
  contextWindowTokens: Math.max(
    1,
    Math.floor(
      params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    ),
  ),
});
```

`installToolResultContextGuard` truncates oversized tool results before they're added to the context window. Without it, a single large tool result (e.g., reading a 500KB file) can overflow the context window and cause the next LLM call to fail.

### What Mastra provides

Mastra does not have a built-in tool result size guard. Tool results are passed as-is to the next LLM call.

### Impact

- Large tool results (file reads, shell output) will overflow the context window
- The LLM call will fail with a context overflow error
- This is a regression from the pi path for any agent that reads large files

### Resolution required

The plan must specify a tool result size guard in the Mastra tool adapter (`tool-adapter.ts`). The `execute` function in each `createTool()` call must truncate results that exceed a configurable byte limit.

---

## Issue 6 — `sanitizeSessionHistory` / `validateGeminiTurns` / `validateAnthropicTurns` Have No Mastra Equivalent

### Severity: **High**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:856-883`](src/agents/pi-embedded-runner/run/attempt.ts:856):

```typescript
const prior = await sanitizeSessionHistory({
  messages: activeSession.messages,
  modelApi: params.model.api,
  modelId: params.modelId,
  provider: params.provider,
  allowedToolNames,
  config: params.config,
  sessionManager,
  sessionId: params.sessionId,
  policy: transcriptPolicy,
});
const validatedGemini = transcriptPolicy.validateGeminiTurns
  ? validateGeminiTurns(prior)
  : prior;
const validated = transcriptPolicy.validateAnthropicTurns
  ? validateAnthropicTurns(validatedGemini)
  : validatedGemini;
const truncated = limitHistoryTurns(validated, getDmHistoryLimitFromSessionKey(...));
const limited = transcriptPolicy.repairToolUseResultPairing
  ? sanitizeToolUseResultPairing(truncated)
  : truncated;
```

This pipeline:
1. Removes tool results for tools not in `allowedToolNames` (prevents orphaned tool results)
2. Validates Gemini turn ordering (Gemini rejects consecutive same-role messages)
3. Validates Anthropic turn ordering (Anthropic rejects consecutive same-role messages)
4. Limits history to DM history limit
5. Repairs orphaned tool_use/tool_result pairs after truncation

### What Mastra provides

Mastra passes `CoreMessage[]` directly to the provider. No sanitization is applied.

### Impact

- Gemini will reject requests with consecutive same-role messages (common after compaction)
- Anthropic will reject requests with consecutive same-role messages
- Orphaned tool results will cause provider errors
- History truncation will not be applied (DM sessions may accumulate unbounded history)

### Resolution required

The `message-adapter.ts` must apply the same sanitization pipeline to `CoreMessage[]` before passing to `agent.stream()`. The `toCoreMessages()` function must accept a `transcriptPolicy` parameter and apply the relevant validations.

---

## Issue 7 — `pruneProcessedHistoryImages` Has No Mastra Equivalent

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1125-1128`](src/agents/pi-embedded-runner/run/attempt.ts:1125):

```typescript
const didPruneImages = pruneProcessedHistoryImages(activeSession.messages);
if (didPruneImages) {
  activeSession.agent.replaceMessages(activeSession.messages);
}
```

Removes image payloads from already-answered user turns to prevent re-sending large image data on every subsequent LLM call.

### Impact

- Sessions with images will re-send image data on every turn
- Significant token cost increase for image-heavy sessions
- May cause context overflow for sessions with many images

### Resolution required

Apply `pruneProcessedHistoryImages` to `CoreMessage[]` before passing to `agent.stream()`.

---

## Issue 8 — `detectAndLoadPromptImages` Integration

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1132-1145`](src/agents/pi-embedded-runner/run/attempt.ts:1132):

```typescript
const imageResult = await detectAndLoadPromptImages({
  prompt: effectivePrompt,
  workspaceDir: effectiveWorkspace,
  model: params.model,
  existingImages: params.images,
  maxBytes: MAX_IMAGE_BYTES,
  maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
  workspaceOnly: effectiveFsWorkspaceOnly,
  sandbox: sandbox?.enabled && sandbox?.fsBridge ? { ... } : undefined,
});

if (imageResult.images.length > 0) {
  await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
} else {
  await abortable(activeSession.prompt(effectivePrompt));
}
```

Images are passed to `session.prompt()` as a separate parameter. The pi-coding-agent handles injecting them into the message content.

### What Mastra provides

Mastra's `agent.stream()` accepts `CoreMessage[]`. Images must be embedded as `{ type: "image", image: ... }` content parts in the user message.

### Impact

- Image support requires the Mastra path to convert `imageResult.images` into `CoreMessage` image content parts
- The plan does not specify how images are passed to `agent.stream()`

### Resolution required

The `message-adapter.ts` must handle image injection: when `imageResult.images.length > 0`, the final user message must include image content parts.

---

## Issue 9 — `repairSessionFileIfNeeded` / Orphaned User Message Repair

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:620-623`](src/agents/pi-embedded-runner/run/attempt.ts:620):

```typescript
await repairSessionFileIfNeeded({
  sessionFile: params.sessionFile,
  warn: (message) => log.warn(message),
});
```

And at line 1107-1120:

```typescript
const leafEntry = sessionManager.getLeafEntry();
if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
  if (leafEntry.parentId) {
    sessionManager.branch(leafEntry.parentId);
  } else {
    sessionManager.resetLeaf();
  }
  const sessionContext = sessionManager.buildSessionContext();
  activeSession.agent.replaceMessages(sessionContext.messages);
  log.warn(`Removed orphaned user message...`);
}
```

This repairs JSONL session files that have orphaned trailing user messages (e.g., from a previous crash mid-run).

### Impact

- Without this repair, the Mastra path will send consecutive user messages to the provider
- Anthropic and Gemini will reject consecutive user messages
- Sessions that crashed mid-run will be permanently broken

### Resolution required

The `session-manager-compat.ts` must apply the same orphaned user message repair before loading messages for the Mastra path.

---

## Issue 10 — `cacheTrace` / `anthropicPayloadLogger` Have No Mastra Equivalent

### Severity: **Low** (diagnostic only)

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:738-758`](src/agents/pi-embedded-runner/run/attempt.ts:738):

```typescript
const cacheTrace = createCacheTrace({ ... });
const anthropicPayloadLogger = createAnthropicPayloadLogger({ ... });
```

These are diagnostic tools that record LLM request/response payloads for debugging. They wrap `streamFn` to intercept all LLM calls.

### Impact

- Cache tracing and payload logging will not work in the Mastra path
- Debugging Mastra runs will be harder

### Resolution required

Document that `OPENCLAW_CACHE_TRACE` and `OPENCLAW_ANTHROPIC_PAYLOAD_LOG` env vars have no effect with `gateway = "mastra"`. Add a Phase 2 item to implement equivalent logging.

---

## Issue 11 — `flushPendingToolResultsAfterIdle` Has No Mastra Equivalent

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1427-1430`](src/agents/pi-embedded-runner/run/attempt.ts:1427):

```typescript
await flushPendingToolResultsAfterIdle({
  agent: session?.agent,
  sessionManager,
});
```

This waits for the agent to be truly idle before flushing pending tool results. Without it, synthetic "missing tool result" errors are inserted while tools are still executing (see issue #8643).

### Impact

- The Mastra path may have similar race conditions between tool execution completion and session cleanup
- The plan does not address this

### Resolution required

The `subscribeMastraSession()` implementation must ensure all tool executions have completed before the stream is considered finished.

---

## Issue 12 — `before_prompt_build` / `before_agent_start` / `agent_end` / `llm_input` / `llm_output` Hooks

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1077-1098`](src/agents/pi-embedded-runner/run/attempt.ts:1077):

```typescript
const hookResult = await resolvePromptBuildHookResult({
  prompt: params.prompt,
  messages: activeSession.messages,
  hookCtx,
  hookRunner,
  legacyBeforeAgentStartResult: params.legacyBeforeAgentStartResult,
});
```

And at lines 1171-1195 (`llm_input` hook), 1310-1330 (`agent_end` hook), 1367-1390 (`llm_output` hook).

These plugin hooks allow external plugins to:
- Inject context into the prompt (`before_prompt_build`)
- Override the system prompt (`before_agent_start`)
- Log LLM inputs/outputs (`llm_input`, `llm_output`)
- React to agent completion (`agent_end`)

### Impact

- All plugin hooks will be silently skipped in the Mastra path
- Plugins that rely on `before_prompt_build` to inject context will not work
- Plugins that rely on `llm_output` for logging/analytics will not work

### Resolution required

The plan must specify that all plugin hooks are called in the Mastra path at the equivalent points:
- `before_prompt_build`: before `agent.stream()` is called
- `llm_input`: before `agent.stream()` is called
- `agent_end`: after `agent.stream()` completes
- `llm_output`: after `agent.stream()` completes

---

## Issue 13 — `clientTools` (OpenResponses Hosted Tools) Have No Mastra Equivalent

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:695-709`](src/agents/pi-embedded-runner/run/attempt.ts:695):

```typescript
const clientToolDefs = params.clientTools
  ? toClientToolDefinitions(
      params.clientTools,
      (toolName, toolParams) => {
        clientToolCallDetected = { name: toolName, params: toolParams };
      },
      { agentId, sessionKey, loopDetection },
    )
  : [];
const allCustomTools = [...customTools, ...clientToolDefs];
```

`clientTools` are OpenResponses-hosted tools that are passed as tool definitions to the LLM but executed server-side. The pi path passes them as `customTools` to `createAgentSession`.

### Impact

- OpenResponses hosted tools will not work in the Mastra path
- `clientToolCall` in `EmbeddedRunAttemptResult` will always be `undefined`

### Resolution required

The plan must specify how `clientTools` are passed to Mastra's `Agent` constructor. They should be included in the `tools` record alongside the standard OpenClaw tools.

---

## Issue 14 — `transcriptPolicy` (Provider-Specific Message Format Rules)

### Severity: **High**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:629-633`](src/agents/pi-embedded-runner/run/attempt.ts:629):

```typescript
const transcriptPolicy = resolveTranscriptPolicy({
  modelApi: params.model?.api,
  provider: params.provider,
  modelId: params.modelId,
});
```

`transcriptPolicy` controls:
- `allowSyntheticToolResults`: Whether to allow synthetic tool results in the session
- `dropThinkingBlocks`: Whether to strip thinking blocks from outbound requests
- `sanitizeToolCallIds`: Whether to normalize tool call IDs
- `toolCallIdMode`: The normalization mode for tool call IDs
- `validateGeminiTurns`: Whether to validate Gemini turn ordering
- `validateAnthropicTurns`: Whether to validate Anthropic turn ordering
- `repairToolUseResultPairing`: Whether to repair orphaned tool_use/tool_result pairs

### Impact

All of these policies are provider-specific and must be applied in the Mastra path. Without them, many providers will reject requests or produce incorrect behavior.

### Resolution required

`resolveTranscriptPolicy()` must be called in the Mastra path and its output applied to the `CoreMessage[]` before passing to `agent.stream()`.

---

## Issue 15 — `compactionOccurredThisAttempt` / `appendCacheTtlTimestamp` Logic

### Severity: **Low**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1241-1260`](src/agents/pi-embedded-runner/run/attempt.ts:1241):

```typescript
const compactionOccurredThisAttempt = getCompactionCount() > 0;
if (!timedOutDuringCompaction && !compactionOccurredThisAttempt) {
  const shouldTrackCacheTtl =
    params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
    isCacheTtlEligibleProvider(params.provider, params.modelId);
  if (shouldTrackCacheTtl) {
    appendCacheTtlTimestamp(sessionManager, { ... });
  }
}
```

Cache-TTL timestamps are appended to the session after each successful run (when no compaction occurred). This is used by the context pruning extension to determine which messages to prune.

### Impact

- Cache-TTL context pruning will not work in the Mastra path (already blocked by Blocker 5)
- The timestamp will not be appended, so if the user switches back to `gateway = "pi"`, the context pruning state will be stale

### Resolution required

Already addressed by Blocker 5 (throw `ConfigurationError` for `contextPruning.mode = "cache-ttl"`). No additional action needed.

---

## Issue 16 — `selectCompactionTimeoutSnapshot` / Compaction Timeout Handling

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1264-1278`](src/agents/pi-embedded-runner/run/attempt.ts:1264):

```typescript
const snapshotSelection = selectCompactionTimeoutSnapshot({
  timedOutDuringCompaction,
  preCompactionSnapshot,
  preCompactionSessionId,
  currentSnapshot: activeSession.messages.slice(),
  currentSessionId: activeSession.sessionId,
});
```

When a timeout occurs during compaction, the pi path uses the pre-compaction message snapshot to avoid returning a partially-compacted session state.

### Impact

- The Mastra path has no equivalent compaction timeout handling
- If a timeout occurs during Mastra compaction, the session state may be inconsistent

### Resolution required

The `mastraCompact()` function must handle timeouts gracefully. If compaction is aborted mid-way, the JSONL file must not be partially written.

---

## Issue 17 — `sessionManager.appendCustomEntry("openclaw:prompt-error")` Has No Mastra Equivalent

### Severity: **Low**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1282-1295`](src/agents/pi-embedded-runner/run/attempt.ts:1282):

```typescript
if (promptError && promptErrorSource === "prompt" && !compactionOccurredThisAttempt) {
  sessionManager.appendCustomEntry("openclaw:prompt-error", {
    timestamp: Date.now(),
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    api: params.model.api,
    error: describeUnknownError(promptError),
  });
}
```

Prompt errors are persisted to the JSONL session file for debugging.

### Impact

- Prompt errors in the Mastra path will not be persisted to the session file
- Debugging failed Mastra runs will be harder

### Resolution required

The Mastra path should write an equivalent error entry to the JSONL session file when `agent.stream()` throws.

---

## Issue 18 — `cloudCodeAssistFormatError` Detection Has No Mastra Equivalent

### Severity: **Low**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:1409-1411`](src/agents/pi-embedded-runner/run/attempt.ts:1409):

```typescript
cloudCodeAssistFormatError: Boolean(
  lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
),
```

Detects Cloud Code Assist format errors in the last assistant message and returns them in the result for special handling by the caller.

### Impact

- Cloud Code Assist format errors will not be detected in the Mastra path
- The caller will not apply the special error handling for these errors

### Resolution required

The `subscribeMastraSession()` implementation must detect equivalent error patterns in the Mastra stream's `error` chunks and set `cloudCodeAssistFormatError` in the result.

---

## Issue 19 — `sandbox` Integration Has No Mastra Equivalent

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:343-353`](src/agents/pi-embedded-runner/run/attempt.ts:343):

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});
const effectiveWorkspace = sandbox?.enabled
  ? sandbox.workspaceAccess === "rw"
    ? resolvedWorkspace
    : sandbox.workspaceDir
  : resolvedWorkspace;
```

The sandbox context affects:
- Which workspace directory tools operate in
- Whether tools are sandboxed
- `splitSdkTools` behavior (line 684-687)
- Image loading sandbox path restrictions (line 1141-1144)

### Impact

- Sandbox configuration will be passed to `createOpenClawCodingTools()` which is shared between pi and Mastra paths
- The sandbox context itself is not Mastra-specific — it affects tool behavior, not the LLM call
- This is likely already handled correctly since tools are created before the gateway branch

### Resolution required

Verify that `createOpenClawCodingTools()` is called with the same sandbox context in the Mastra path as in the pi path. The plan's current design (creating tools before the gateway branch) handles this correctly.

---

## Issue 20 — `reasoningLevel` / `thinkLevel` Mapping

### Severity: **Medium**

### What the pi path does

[`src/agents/pi-embedded-runner/run/attempt.ts:717`](src/agents/pi-embedded-runner/run/attempt.ts:717):

```typescript
thinkingLevel: mapThinkingLevel(params.thinkLevel),
```

`mapThinkingLevel` converts OpenClaw's `ThinkLevel` ("low"/"medium"/"high"/"off") to pi-coding-agent's `ThinkingLevel` enum.

The plan mentions `toMastraProviderOptions(params.thinkLevel, params.provider)` but does not specify the full mapping for all providers:
- Anthropic: `{ thinking: { type: "enabled", budgetTokens: N } }`
- OpenAI: `{ reasoningEffort: "low"/"medium"/"high" }`
- Google: `{ thinkingConfig: { thinkingBudget: N } }`
- Bedrock: Anthropic format via `@ai-sdk/amazon-bedrock`

### Impact

- Thinking/reasoning will not work correctly for providers where the mapping is not specified
- The plan only mentions Anthropic and OpenAI formats

### Resolution required

The plan must specify the complete `toMastraProviderOptions()` mapping for all providers that support thinking/reasoning.

---

## Summary: Issues by Severity

### Critical (must fix before Phase 1 can ship)

| # | Issue | Impact |
|---|---|---|
| 1 | `queueMessage` / `steer()` — no mid-run message injection | Messages dropped during active runs |
| 2 | `isStreaming` / `isCompacting` state tracking | Incorrect run state, abort timer fires immediately |

### High (must fix before Phase 1 can ship)

| # | Issue | Impact |
|---|---|---|
| 3 | `streamFn` wrapping pipeline | Thinking blocks, tool call ID sanitization, tool name trimming all broken |
| 4 | `applyExtraParamsToAgent` | Temperature, maxTokens, caching, OpenRouter routing all broken |
| 5 | `installToolResultContextGuard` | Large tool results overflow context window |
| 6 | `sanitizeSessionHistory` / turn validation | Gemini/Anthropic reject consecutive same-role messages |
| 14 | `transcriptPolicy` | Provider-specific message format rules not applied |

### Medium (should fix before Phase 1 ships)

| # | Issue | Impact |
|---|---|---|
| 7 | `pruneProcessedHistoryImages` | Image re-sending on every turn, token cost increase |
| 8 | `detectAndLoadPromptImages` integration | Images not passed to Mastra correctly |
| 9 | `repairSessionFileIfNeeded` / orphaned user message repair | Crashed sessions permanently broken |
| 11 | `flushPendingToolResultsAfterIdle` | Race condition in tool execution cleanup |
| 12 | Plugin hooks | All plugin hooks silently skipped |
| 13 | `clientTools` (OpenResponses) | Hosted tools not supported |
| 16 | Compaction timeout handling | Inconsistent session state on timeout |
| 19 | Sandbox integration | Verify tools created with correct sandbox context |
| 20 | `reasoningLevel` / `thinkLevel` mapping | Thinking broken for some providers |

### Low (document or fix in Phase 2)

| # | Issue | Impact |
|---|---|---|
| 10 | `cacheTrace` / `anthropicPayloadLogger` | Diagnostic tools not available |
| 15 | `appendCacheTtlTimestamp` | Already blocked by Blocker 5 |
| 17 | `appendCustomEntry("openclaw:prompt-error")` | Error debugging harder |
| 18 | `cloudCodeAssistFormatError` detection | Special error handling not applied |

---

## Architecture Observation: The Plan's Scope Is Too Narrow

The plan describes the Mastra integration as a "feature-flagged adapter layer" that "emits the same events as the pi path." This framing understates the complexity.

The existing pi path is not just an LLM call — it is a **350-line orchestration pipeline** that:
1. Resolves sandbox context
2. Loads skills and applies env overrides
3. Builds the system prompt (with hooks)
4. Acquires a session write lock
5. Opens and repairs the session file
6. Builds extension factories (compaction safeguard, context pruning)
7. Creates tools with sandbox/channel context
8. Wraps `streamFn` with 5+ layers of sanitization
9. Sanitizes session history (provider-specific)
10. Runs `before_prompt_build` hooks
11. Loads and injects images
12. Calls `session.prompt()` with abort support
13. Waits for compaction retry
14. Appends cache-TTL timestamps
15. Runs `agent_end` and `llm_output` hooks
16. Flushes pending tool results
17. Disposes the session
18. Releases the write lock

The Mastra path must replicate **all of this** — not just the LLM call. The plan's current design only addresses steps 11 (partially), 12, and 13. Steps 1-10 and 14-18 are either missing or unspecified.

The correct architecture is: the Mastra path **replaces only steps 6 (extension factories) and 12 (the LLM call itself)**. All other steps should be shared between the pi and Mastra paths.

---

## Recommended Architecture Revision

Instead of:
```
if (usesMastra) {
  return runMastraAgent({ ...params });
} else {
  // existing pi path
}
```

The correct structure is:
```
// Shared pre-run setup (steps 1-11, 14-18)
const { tools, sessionManager, systemPrompt, messages, ... } = await prepareRunContext(params);

// Gateway-specific LLM call (step 12)
if (usesMastra) {
  result = await runMastraLlmCall({ tools, messages, systemPrompt, ... });
} else {
  result = await runPiLlmCall({ session, ... });
}

// Shared post-run cleanup (steps 14-18)
await finalizeRun(result, sessionManager, ...);
```

This ensures all the shared infrastructure (hooks, sanitization, image loading, session repair, etc.) is applied regardless of which gateway is used.
