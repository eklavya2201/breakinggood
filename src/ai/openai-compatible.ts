import { OUTPUT_LIMIT_MESSAGE, type CompleteRequest, type Provider } from "./provider.js";

/**
 * OpenAI's reasoning models (gpt-5, o-series) reject `max_tokens` on chat completions
 * and want `max_completion_tokens`. Groq, OpenRouter, Ollama etc. still use `max_tokens`.
 */
export type TokenParam = "max_tokens" | "max_completion_tokens";

/**
 * Works with any server speaking the OpenAI chat-completions dialect:
 * OpenAI, Groq, OpenRouter, Together, Ollama, LM Studio, vLLM…
 */
export class OpenAICompatibleProvider implements Provider {
  readonly supportsImages: boolean;

  constructor(
    readonly name: string,
    readonly model: string,
    private baseUrl: string,
    private apiKey: string | undefined,
    supportsImages = true,
    private tokenParam: TokenParam = "max_tokens",
  ) {
    this.supportsImages = supportsImages;
  }

  async complete(req: CompleteRequest): Promise<string> {
    const userContent: unknown[] = [];
    if (this.supportsImages) {
      for (const img of req.images ?? []) {
        userContent.push({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        });
      }
    }
    userContent.push({ type: "text", text: req.prompt });

    const body = {
      model: this.model,
      stream: true,
      [this.tokenParam]: req.maxTokens ?? 16000,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: userContent },
      ],
    };

    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.name} API error ${res.status}: ${text.slice(0, 500)}`);
    }

    // Parse the SSE stream.
    let full = "";
    let buffer = "";
    let finishReason: string | undefined;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0];
          const delta: string | undefined = choice?.delta?.content;
          if (delta) {
            full += delta;
            req.onChunk?.(delta);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        } catch {
          /* ignore keep-alives */
        }
      }
    }
    if (finishReason === "length") {
      throw new Error(OUTPUT_LIMIT_MESSAGE);
    }
    return full;
  }
}
