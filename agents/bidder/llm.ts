// Provider-agnostic LLM client used by the bidder loop. Two adapters:
//   - AnthropicAdapter — wraps @anthropic-ai/sdk, the canonical path.
//     Supports the system-prompt cache breakpoint.
//   - OpenAICompatibleAdapter — POSTs to /v1/chat/completions on any
//     compatible host (OpenAI, OpenRouter, Together, Groq, vLLM,
//     Cerebras, locally-hosted, …). No prompt caching — the spec
//     doesn't standardize it, so we pay full prompt tokens per call.
//
// Why a single normalized interface instead of two parallel code
// paths in index.ts: the bidder loop only needs three things back —
// any text blocks (skip rationale), any tool_use blocks (place_bid
// invocation), and a usage record. The two providers hand those back
// in different shapes; flattening here means the loop logic stays
// provider-agnostic and is unit-testable against a fake client.

import Anthropic from "@anthropic-ai/sdk";

/** Neutral tool definition. Adapters translate to their provider's
 *  exact shape (Anthropic: `input_schema`; OpenAI: `function.parameters`). */
export interface LLMTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  schema: Record<string, unknown>;
}

export interface LLMEvaluateRequest {
  systemPrompt: string;
  userMessage: string;
  tools: LLMTool[];
  model: string;
  maxTokens: number;
}

export interface LLMTextBlock {
  type: "text";
  text: string;
}

export interface LLMToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock;

export interface LLMUsage {
  /** Anthropic-only; 0 for OpenAI-compatible. */
  cacheReadTokens: number;
  /** Anthropic-only; 0 for OpenAI-compatible. */
  cacheCreationTokens: number;
  /** Provider's prompt-token count (best effort — some hosts omit this). */
  inputTokens: number;
  /** Provider's completion-token count. */
  outputTokens: number;
}

export interface LLMEvaluateResponse {
  content: LLMContentBlock[];
  /** Free-form provider-defined string ("end_turn", "tool_use", "stop", …). */
  stopReason: string | null;
  usage: LLMUsage;
}

export interface LLMClient {
  /** Provider name as it appears in logs. */
  readonly providerName: string;
  evaluate(req: LLMEvaluateRequest): Promise<LLMEvaluateResponse>;
}

/** Anthropic adapter — uses the SDK and the system cache breakpoint. */
export class AnthropicAdapter implements LLMClient {
  readonly providerName = "anthropic";
  constructor(private readonly client: Anthropic) {}

  async evaluate(req: LLMEvaluateRequest): Promise<LLMEvaluateResponse> {
    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: [
        {
          type: "text",
          text: req.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema as Anthropic.Tool["input_schema"],
      })),
      messages: [{ role: "user", content: req.userMessage }],
    });

    const content: LLMContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return {
      content,
      stopReason: response.stop_reason ?? null,
      usage: {
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
      },
    };
  }
}

/** OpenAI Chat Completions message-role shape, narrowed to what we send. */
interface OAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OAIChatToolCall[];
}

interface OAIChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIChatChoice {
  message: OAIChatMessage;
  finish_reason: string | null;
}

interface OAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OAIChatResponse {
  choices: OAIChatChoice[];
  usage?: OAIChatUsage;
}

export interface OpenAICompatibleConfig {
  /** API base URL — must end before /chat/completions. e.g.
   *  "https://api.openai.com/v1", "https://openrouter.ai/api/v1". */
  baseUrl: string;
  apiKey: string;
  /** Optional `fetch` override for tests. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 60s. */
  timeoutMs?: number;
}

const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;

/** Strip a trailing `/chat/completions` if a user pasted the full URL. */
export function normalizeOpenAIBaseUrl(url: string): string {
  let u = url.trim();
  while (u.endsWith("/")) u = u.slice(0, -1);
  if (u.endsWith("/chat/completions")) {
    u = u.slice(0, -"/chat/completions".length);
  }
  while (u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

export class OpenAICompatibleAdapter implements LLMClient {
  readonly providerName = "openai-compatible";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: OpenAICompatibleConfig) {
    this.baseUrl = normalizeOpenAIBaseUrl(cfg.baseUrl);
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
  }

  async evaluate(req: LLMEvaluateRequest): Promise<LLMEvaluateResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}/chat/completions`;
      const body = {
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userMessage },
        ],
        tools: req.tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.schema,
          },
        })),
        tool_choice: "auto" as const,
      };

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        throw new Error(
          `openai-compatible /chat/completions ${res.status}: ${errText.slice(0, 400)}`
        );
      }
      const data = (await res.json()) as OAIChatResponse;
      return parseOpenAIChatResponse(data);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        throw new Error(
          `openai-compatible /chat/completions timeout after ${this.timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pure parser — exported so tests can hand it canned response shapes. */
export function parseOpenAIChatResponse(data: OAIChatResponse): LLMEvaluateResponse {
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("openai-compatible response had no choices[]");
  }
  const choice = data.choices[0];
  const msg: OAIChatMessage = choice.message ?? { role: "assistant" };
  const content: LLMContentBlock[] = [];
  if (typeof msg.content === "string" && msg.content.trim().length > 0) {
    content.push({ type: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.type !== "function" || !tc.function?.name) continue;
      let parsed: Record<string, unknown> = {};
      const raw = tc.function.arguments;
      if (typeof raw === "string" && raw.trim().length > 0) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // Some hosts return a half-formed args string when the model
          // truncates. Surface as empty input so the bidder's existing
          // "missing required fields" check rejects the call cleanly
          // instead of blowing up with a JSON parse error.
          parsed = {};
        }
      }
      content.push({ type: "tool_use", name: tc.function.name, input: parsed });
    }
  }
  return {
    content,
    stopReason: choice.finish_reason ?? null,
    usage: {
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

/** Bidder-runtime LLM provider as configured by env. */
export type LLMProvider = "anthropic" | "openai-compatible";

export interface LLMRuntimeConfig {
  provider: LLMProvider;
  /** Provider model id. Required for openai-compatible; optional for
   *  anthropic (defaulted by the caller). */
  model: string;
  /** Required for openai-compatible. */
  endpoint?: string;
  /** Provider API key. */
  apiKey: string;
}

/**
 * Decide which provider/model/endpoint/key to use based on env vars.
 * Pure — does not read process.env directly so it stays unit-testable.
 *
 * Env contract (passed in via `env`):
 *   BIDDER_LLM_PROVIDER          "anthropic" | "openai-compatible"
 *                                default: anthropic when ANTHROPIC_API_KEY present
 *   BIDDER_LLM_MODEL             provider model id; required for openai-compatible
 *   BIDDER_LLM_ENDPOINT          base URL (.../v1) for openai-compatible
 *   BIDDER_LLM_API_KEY           provider key; falls back to ANTHROPIC_API_KEY
 *                                when provider=anthropic for back-compat
 *   ANTHROPIC_API_KEY            legacy alias used by the original loop
 */
export function resolveLLMRuntime(
  env: Record<string, string | undefined>,
  defaults: { anthropicModel: string }
): LLMRuntimeConfig {
  const rawProvider = env.BIDDER_LLM_PROVIDER?.trim() || "";
  let provider: LLMProvider;
  if (rawProvider === "openai-compatible" || rawProvider === "openai") {
    provider = "openai-compatible";
  } else if (rawProvider === "anthropic" || rawProvider === "") {
    provider = "anthropic";
  } else {
    throw new Error(
      `BIDDER_LLM_PROVIDER must be "anthropic" or "openai-compatible", got: ${rawProvider}`
    );
  }

  if (provider === "anthropic") {
    const apiKey =
      env.BIDDER_LLM_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || "";
    if (!apiKey) {
      throw new Error(
        "anthropic provider requires BIDDER_LLM_API_KEY (or legacy ANTHROPIC_API_KEY)"
      );
    }
    return {
      provider,
      apiKey,
      model: env.BIDDER_LLM_MODEL?.trim() || defaults.anthropicModel,
    };
  }

  // openai-compatible
  const apiKey = env.BIDDER_LLM_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new Error("openai-compatible provider requires BIDDER_LLM_API_KEY");
  }
  const endpoint = env.BIDDER_LLM_ENDPOINT?.trim() || "";
  if (!endpoint) {
    throw new Error("openai-compatible provider requires BIDDER_LLM_ENDPOINT");
  }
  const model = env.BIDDER_LLM_MODEL?.trim() || "";
  if (!model) {
    throw new Error(
      "openai-compatible provider requires BIDDER_LLM_MODEL (no sensible default across hosts)"
    );
  }
  return { provider, model, endpoint, apiKey };
}

/** Factory: build a concrete LLMClient from a resolved config. */
export function makeLLMClient(cfg: LLMRuntimeConfig): LLMClient {
  if (cfg.provider === "anthropic") {
    return new AnthropicAdapter(new Anthropic({ apiKey: cfg.apiKey }));
  }
  return new OpenAICompatibleAdapter({
    baseUrl: cfg.endpoint!,
    apiKey: cfg.apiKey,
  });
}
