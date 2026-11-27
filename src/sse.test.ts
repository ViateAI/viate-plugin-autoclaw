import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RelayConverter, completionFromSse } from "./sse.js";

describe("relay event conversion", () => {
  it("diffs snapshot text and stops on the matching run", () => {
    const converter = new RelayConverter({ runId: "run-1", session: "main", model: "glm-5.3-flash", id: "chatcmpl-1", created: 10 });
    converter.pushFrame({ event: "agent:stream", payload: { runId: "other", type: "text", delta: "nope" } });
    converter.pushFrame({ event: "agent:stream", payload: { runId: "run-1", type: "text", delta: "He" } });
    converter.pushFrame({ event: "agent:stream", payload: { runId: "run-1", type: "text", delta: "Hello" } });
    converter.pushFrame({
      event: "agent:stream",
      payload: { runId: "run-1", type: "done", usage: { input: 3, output: 2, total: 5 } },
    });
    const body = completionFromSse(converter.take(), "glm-5.3-flash");
    const parsed = JSON.parse(body) as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number } };
    assert.equal(parsed.choices[0]?.message.content, "Hello");
    assert.equal(parsed.usage.prompt_tokens, 3);
  });
});
