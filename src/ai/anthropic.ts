import Anthropic from "@anthropic-ai/sdk";
import { OUTPUT_LIMIT_MESSAGE, type CompleteRequest, type Provider } from "./provider.js";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly supportsImages = true;
  private client: Anthropic;

  constructor(readonly model: string = "claude-opus-5-5") {
    this.client = new Anthropic();
  }

  async complete(req: CompleteRequest): Promise<string> {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of req.images ?? []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.base64 },
      });
    }
    content.push({ type: "text", text: req.prompt });

    // Streaming: generated projects are long, and streaming avoids HTTP timeouts.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? 128000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content }],
    });

    stream.on("text", (t) => req.onChunk?.(t));
    const final = await stream.finalMessage();

    if (final.stop_reason === "refusal") {
      throw new Error(
        `The model declined this request (${final.stop_details?.category ?? "unspecified"}). ` +
          "Try a different page or provider.",
      );
    }
    if (final.stop_reason === "max_tokens") {
      throw new Error(OUTPUT_LIMIT_MESSAGE);
    }
    return final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
