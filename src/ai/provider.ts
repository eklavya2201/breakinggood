/**
 * Provider-neutral AI layer. breakinggood works with whichever key you have:
 *
 *   ANTHROPIC_API_KEY  → Claude (official SDK)
 *   OPENAI_API_KEY     → OpenAI
 *   GROQ_API_KEY       → Groq      (OpenAI-compatible)
 *   OPENROUTER_API_KEY → OpenRouter(OpenAI-compatible)
 *   GEMINI_API_KEY     → Google Gemini
 *   OLLAMA_HOST        → local Ollama (OpenAI-compatible, no key)
 *
 * Override with BREAKINGGOOD_PROVIDER / BREAKINGGOOD_MODEL or --provider / --model.
 */

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg";
  base64: string;
}

export interface CompleteRequest {
  system: string;
  prompt: string;
  images?: ImageInput[];
  maxTokens?: number;
  /** Called with text chunks as they stream (when the provider supports it). */
  onChunk?: (text: string) => void;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  readonly supportsImages: boolean;
  complete(req: CompleteRequest): Promise<string>;
}

export interface ProviderOptions {
  provider?: string;
  model?: string;
}

/** Shared by every provider so a truncated generation reads the same everywhere. */
export const OUTPUT_LIMIT_MESSAGE =
  "The model hit its output limit before finishing. Try a simpler page.";

export class NoProviderError extends Error {
  constructor() {
    super(
      "No AI provider configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, " +
        "OPENROUTER_API_KEY, GEMINI_API_KEY, or OLLAMA_HOST.",
    );
  }
}
