import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOpenAIResponsesUsage } from "@viateai/sdk";
import { chatJsonToResponse, chatSseToResponses, responsesRequestToChat } from "./responses.js";

describe("autoclaw responses", () => {
  it("turns a responses request into a chat completion", () => {
    const converted = responsesRequestToChat({ model: "glm-5.4", input: "hi", stream: true });
    assert.equal(converted.ok, true);
    if (!converted.ok) {
      return;
    }
    assert.deepEqual(converted.chat, {
      model: "glm-5.4",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("emits a completed responses stream from chat chunks", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"He"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const out = chatSseToResponses(sse, "glm-5.4");
    assert.match(out, /response\.output_text\.delta/);
    assert.match(out, /response\.completed/);
    const frames: unknown[] = [];
    for (const block of out.split("\n\n")) {
      const data = block.split("\n").find((line) => line.startsWith("data:"));
      if (!data) {
        continue;
      }
      frames.push(JSON.parse(data.slice(5).trim()) as unknown);
    }
    const usage = parseOpenAIResponsesUsage(frames);
    assert.deepEqual(usage, { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const completed = frames.find((frame) => frame && typeof frame === "object" && "type" in frame && frame.type === "response.completed");
    assert.ok(completed && typeof completed === "object" && "response" in completed);
    const response = completed.response;
    assert.ok(response && typeof response === "object" && "output" in response && Array.isArray(response.output));
    const item = response.output[0];
    assert.ok(item && typeof item === "object" && "content" in item && Array.isArray(item.content));
    const part = item.content[0];
    assert.ok(part && typeof part === "object" && "text" in part);
    assert.equal(part.text, "Hello");
    assert.equal(chatJsonToResponse({
      model: "glm-5.4",
      choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }, "glm-5.4").status, "completed");
  });
});
