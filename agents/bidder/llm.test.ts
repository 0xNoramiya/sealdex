import { describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleAdapter,
  normalizeOpenAIBaseUrl,
  parseOpenAIChatResponse,
  resolveLLMRuntime,
} from "./llm.js";

const PLACE_BID_TOOL = {
  name: "place_bid",
  description: "place a sealed bid",
  schema: {
    type: "object",
    properties: {
      amount_usdc: { type: "integer" },
      reasoning: { type: "string" },
    },
    required: ["amount_usdc", "reasoning"],
  },
};

describe("normalizeOpenAIBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeOpenAIBaseUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1"
    );
    expect(normalizeOpenAIBaseUrl("https://api.openai.com/v1//")).toBe(
      "https://api.openai.com/v1"
    );
  });

  it("strips a trailing /chat/completions", () => {
    expect(
      normalizeOpenAIBaseUrl("https://api.openai.com/v1/chat/completions")
    ).toBe("https://api.openai.com/v1");
  });

  it("strips trailing slash AND /chat/completions together", () => {
    expect(
      normalizeOpenAIBaseUrl("https://openrouter.ai/api/v1/chat/completions/")
    ).toBe("https://openrouter.ai/api/v1");
  });

  it("leaves a clean base URL alone", () => {
    expect(normalizeOpenAIBaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1"
    );
  });
});

describe("parseOpenAIChatResponse", () => {
  it("extracts text-only response when model declines to call a tool", () => {
    const r = parseOpenAIChatResponse({
      choices: [
        {
          message: { role: "assistant", content: "skipping — no match" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 8 },
    });
    expect(r.content).toEqual([
      { type: "text", text: "skipping — no match" },
    ]);
    expect(r.stopReason).toBe("stop");
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(8);
  });

  it("extracts tool_use when model emits a function call", () => {
    const r = parseOpenAIChatResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "place_bid",
                  arguments: '{"amount_usdc": 250, "reasoning": "good lot"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(r.content).toEqual([
      {
        type: "tool_use",
        name: "place_bid",
        input: { amount_usdc: 250, reasoning: "good lot" },
      },
    ]);
    expect(r.stopReason).toBe("tool_calls");
  });

  it("emits both text and tool_use when both present", () => {
    const r = parseOpenAIChatResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "evaluating...",
            tool_calls: [
              {
                id: "x",
                type: "function",
                function: {
                  name: "place_bid",
                  arguments: '{"amount_usdc": 100, "reasoning": "ok"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(r.content).toHaveLength(2);
    expect(r.content[0].type).toBe("text");
    expect(r.content[1].type).toBe("tool_use");
  });

  it("treats empty string content as absent", () => {
    const r = parseOpenAIChatResponse({
      choices: [
        {
          message: { role: "assistant", content: "   " },
          finish_reason: "stop",
        },
      ],
    });
    expect(r.content).toEqual([]);
  });

  it("reduces a malformed tool args string to empty input (not throw)", () => {
    const r = parseOpenAIChatResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "x",
                type: "function",
                function: { name: "place_bid", arguments: "{not json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(r.content).toEqual([
      { type: "tool_use", name: "place_bid", input: {} },
    ]);
  });

  it("skips non-function tool_calls (defensive)", () => {
    const r = parseOpenAIChatResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "x", type: "function" as any, function: { name: "", arguments: "" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    // empty name is filtered out
    expect(r.content).toEqual([]);
  });

  it("throws when choices is missing or empty", () => {
    expect(() => parseOpenAIChatResponse({ choices: [] })).toThrow(/no choices/);
    expect(() => parseOpenAIChatResponse({} as any)).toThrow(/no choices/);
  });

  it("zeroes Anthropic-only cache fields (always)", () => {
    const r = parseOpenAIChatResponse({
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
    });
    expect(r.usage.cacheReadTokens).toBe(0);
    expect(r.usage.cacheCreationTokens).toBe(0);
  });
});

describe("OpenAICompatibleAdapter.evaluate", () => {
  it("posts to /chat/completions with auth + tools translated to function shape", async () => {
    const fetchSpy = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
        { status: 200 }
      );
    });

    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const r = await adapter.evaluate({
      systemPrompt: "you are a bidder",
      userMessage: "lot 1",
      tools: [PLACE_BID_TOOL],
      model: "gpt-4o-mini",
      maxTokens: 256,
    });
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as any).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([
      { role: "system", content: "you are a bidder" },
      { role: "user", content: "lot 1" },
    ]);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "place_bid",
        description: "place a sealed bid",
        parameters: PLACE_BID_TOOL.schema,
      },
    });
    expect(body.tool_choice).toBe("auto");
  });

  it("throws a descriptive error on non-2xx response", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response("rate limited", { status: 429 })
    );
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(
      adapter.evaluate({
        systemPrompt: "s",
        userMessage: "u",
        tools: [],
        model: "m",
        maxTokens: 100,
      })
    ).rejects.toThrow(/429.*rate limited/);
  });

  it("normalizes a base URL with /chat/completions appended", async () => {
    let calledUrl = "";
    const fetchSpy = vi.fn(async (url: any) => {
      calledUrl = url;
      return new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
        }),
        { status: 200 }
      );
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: "x",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await adapter.evaluate({
      systemPrompt: "s",
      userMessage: "u",
      tools: [],
      model: "m",
      maxTokens: 10,
    });
    expect(calledUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("resolveLLMRuntime", () => {
  const defaults = { anthropicModel: "claude-sonnet-4-6" };

  it("defaults to anthropic with ANTHROPIC_API_KEY (back-compat)", () => {
    const r = resolveLLMRuntime(
      { ANTHROPIC_API_KEY: "sk-ant-x" },
      defaults
    );
    expect(r.provider).toBe("anthropic");
    expect(r.apiKey).toBe("sk-ant-x");
    expect(r.model).toBe("claude-sonnet-4-6");
  });

  it("anthropic prefers BIDDER_LLM_API_KEY over ANTHROPIC_API_KEY", () => {
    const r = resolveLLMRuntime(
      {
        BIDDER_LLM_PROVIDER: "anthropic",
        BIDDER_LLM_API_KEY: "sk-new",
        ANTHROPIC_API_KEY: "sk-old",
      },
      defaults
    );
    expect(r.apiKey).toBe("sk-new");
  });

  it("anthropic accepts custom BIDDER_LLM_MODEL", () => {
    const r = resolveLLMRuntime(
      {
        BIDDER_LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "k",
        BIDDER_LLM_MODEL: "claude-haiku-4-5",
      },
      defaults
    );
    expect(r.model).toBe("claude-haiku-4-5");
  });

  it("anthropic without any key throws", () => {
    expect(() => resolveLLMRuntime({}, defaults)).toThrow(/anthropic.*BIDDER_LLM_API_KEY/);
  });

  it("openai-compatible requires endpoint + model + key", () => {
    const r = resolveLLMRuntime(
      {
        BIDDER_LLM_PROVIDER: "openai-compatible",
        BIDDER_LLM_API_KEY: "sk-x",
        BIDDER_LLM_ENDPOINT: "https://openrouter.ai/api/v1",
        BIDDER_LLM_MODEL: "anthropic/claude-3.5-sonnet",
      },
      defaults
    );
    expect(r.provider).toBe("openai-compatible");
    expect(r.endpoint).toBe("https://openrouter.ai/api/v1");
    expect(r.model).toBe("anthropic/claude-3.5-sonnet");
    expect(r.apiKey).toBe("sk-x");
  });

  it("openai-compatible without endpoint throws", () => {
    expect(() =>
      resolveLLMRuntime(
        {
          BIDDER_LLM_PROVIDER: "openai-compatible",
          BIDDER_LLM_API_KEY: "k",
          BIDDER_LLM_MODEL: "x",
        },
        defaults
      )
    ).toThrow(/BIDDER_LLM_ENDPOINT/);
  });

  it("openai-compatible without model throws (no cross-host default)", () => {
    expect(() =>
      resolveLLMRuntime(
        {
          BIDDER_LLM_PROVIDER: "openai-compatible",
          BIDDER_LLM_API_KEY: "k",
          BIDDER_LLM_ENDPOINT: "https://api.example.com/v1",
        },
        defaults
      )
    ).toThrow(/BIDDER_LLM_MODEL/);
  });

  it("rejects unknown provider strings", () => {
    expect(() =>
      resolveLLMRuntime({ BIDDER_LLM_PROVIDER: "cohere" }, defaults)
    ).toThrow(/anthropic.*openai-compatible/);
  });

  it('accepts "openai" as a synonym for openai-compatible', () => {
    const r = resolveLLMRuntime(
      {
        BIDDER_LLM_PROVIDER: "openai",
        BIDDER_LLM_API_KEY: "sk",
        BIDDER_LLM_ENDPOINT: "https://api.openai.com/v1",
        BIDDER_LLM_MODEL: "gpt-4o-mini",
      },
      defaults
    );
    expect(r.provider).toBe("openai-compatible");
  });
});
