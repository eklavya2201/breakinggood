import { OUTPUT_LIMIT_MESSAGE, type CompleteRequest, type Provider } from "./provider.js";

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  readonly supportsImages = true;

  constructor(readonly model: string, private apiKey: string) {}

  async complete(req: CompleteRequest): Promise<string> {
    const parts: unknown[] = [];
    for (const img of req.images ?? []) {
      parts.push({ inline_data: { mime_type: img.mediaType, data: img.base64 } });
    }
    parts.push({ text: req.prompt });

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent` +
      `?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: req.maxTokens ?? 16000 },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    if (json.candidates?.[0]?.finishReason === "MAX_TOKENS") {
      throw new Error(OUTPUT_LIMIT_MESSAGE);
    }
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    req.onChunk?.(text);
    return text;
  }
}
