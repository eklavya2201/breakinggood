import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status },
  );
}

async function withFetch<T>(response: Response, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function provider() {
  return new OpenAICompatibleProvider("Test", "test-model", "https://example.com/v1", "test-key");
}

test("reassembles SSE data lines split across stream chunks", async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"hel',
    'lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);

  const result = await withFetch(response, () =>
    provider().complete({ system: "system", prompt: "prompt" }),
  );

  assert.equal(result, "hello world");
});

test("ignores keep-alive comments, blank lines, and the DONE sentinel", async () => {
  const response = streamResponse([
    ": keep-alive\n\n",
    'data: {"choices":[{"delta":{"content":"first"}}]}\n',
    "\n",
    ": another keep-alive\n",
    "data: [DONE]\n\n",
  ]);

  const result = await withFetch(response, () =>
    provider().complete({ system: "system", prompt: "prompt" }),
  );

  assert.equal(result, "first");
});

test("calls onChunk once for each content delta", async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"one"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"two"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const chunks: string[] = [];

  const result = await withFetch(response, () =>
    provider().complete({
      system: "system",
      prompt: "prompt",
      onChunk: (chunk) => chunks.push(chunk),
    }),
  );

  assert.equal(result, "onetwo");
  assert.deepEqual(chunks, ["one", "two"]);
});

test("throws the output-limit error when the stream finishes with length", async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n",
  ]);

  await assert.rejects(
    withFetch(response, () => provider().complete({ system: "system", prompt: "prompt" })),
    /hit its output limit/,
  );
});

test("returns the text when the stream finishes with stop", async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]);

  const result = await withFetch(response, () =>
    provider().complete({ system: "system", prompt: "prompt" }),
  );

  assert.equal(result, "done");
});

test("includes the HTTP status in non-success response errors", async () => {
  const response = new Response("service unavailable", { status: 503 });

  await assert.rejects(
    withFetch(response, () => provider().complete({ system: "system", prompt: "prompt" })),
    /Test API error 503/,
  );
});
