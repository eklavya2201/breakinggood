import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { NoProviderError, type Provider, type ProviderOptions } from "./provider.js";

interface Candidate {
  id: string;
  available: () => boolean;
  make: (model?: string) => Provider;
  defaultModel: string;
}

const env = (k: string) => process.env[k]?.trim() || undefined;

const CANDIDATES: Candidate[] = [
  {
    id: "anthropic",
    available: () => !!env("ANTHROPIC_API_KEY") || !!env("ANTHROPIC_AUTH_TOKEN"),
    defaultModel: "claude-opus-5-5",
    make: (m) => new AnthropicProvider(m ?? "claude-opus-5-5"),
  },
  {
    id: "openai",
    available: () => !!env("OPENAI_API_KEY"),
    defaultModel: "gpt-5",
    make: (m) =>
      new OpenAICompatibleProvider(
        "openai",
        m ?? "gpt-5",
        env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
        env("OPENAI_API_KEY"),
        true,
        "max_completion_tokens",
      ),
  },
  {
    id: "groq",
    available: () => !!env("GROQ_API_KEY"),
    defaultModel: "llama-3.3-70b-versatile",
    make: (m) =>
      new OpenAICompatibleProvider(
        "groq",
        m ?? "llama-3.3-70b-versatile",
        "https://api.groq.com/openai/v1",
        env("GROQ_API_KEY"),
        false,
      ),
  },
  {
    id: "openrouter",
    available: () => !!env("OPENROUTER_API_KEY"),
    defaultModel: "anthropic/claude-sonnet-4.5",
    make: (m) =>
      new OpenAICompatibleProvider(
        "openrouter",
        m ?? "anthropic/claude-sonnet-4.5",
        "https://openrouter.ai/api/v1",
        env("OPENROUTER_API_KEY"),
      ),
  },
  {
    id: "gemini",
    available: () => !!env("GEMINI_API_KEY"),
    defaultModel: "gemini-2.5-pro",
    make: (m) => new GeminiProvider(m ?? "gemini-2.5-pro", env("GEMINI_API_KEY")!),
  },
  {
    id: "ollama",
    available: () => !!env("OLLAMA_HOST") || !!env("OLLAMA_MODEL"),
    defaultModel: "qwen2.5-coder:14b",
    make: (m) =>
      new OpenAICompatibleProvider(
        "ollama",
        m ?? env("OLLAMA_MODEL") ?? "qwen2.5-coder:14b",
        (env("OLLAMA_HOST") ?? "http://localhost:11434").replace(/\/$/, "") + "/v1",
        undefined,
        false,
      ),
  },
];

export function listProviders(): { id: string; available: boolean; defaultModel: string }[] {
  return CANDIDATES.map((c) => ({ id: c.id, available: c.available(), defaultModel: c.defaultModel }));
}

/** Returns a provider, or null when none is configured. */
export function resolveProvider(opts: ProviderOptions = {}): Provider | null {
  const wanted = opts.provider ?? env("BREAKINGGOOD_PROVIDER");
  const model = opts.model ?? env("BREAKINGGOOD_MODEL");

  if (wanted) {
    const c = CANDIDATES.find((x) => x.id === wanted.toLowerCase());
    if (!c) throw new Error(`Unknown provider "${wanted}". Known: ${CANDIDATES.map((x) => x.id).join(", ")}`);
    if (!c.available()) throw new Error(`Provider "${wanted}" selected but its API key/host is not set.`);
    return c.make(model);
  }
  const first = CANDIDATES.find((c) => c.available());
  return first ? first.make(model) : null;
}

export function requireProvider(opts: ProviderOptions = {}): Provider {
  const p = resolveProvider(opts);
  if (!p) throw new NoProviderError();
  return p;
}
