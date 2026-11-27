import { randomBytes } from "node:crypto";
import { recordValue, stringValue } from "./sse.js";

type ChatBody = {
  model: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
};

export function responsesRequestToChat(body: unknown): { ok: true; chat: ChatBody } | { ok: false; status: number; message: string } {
  const record = recordValue(body) ?? {};
  if (stringValue(record.previous_response_id) || record.conversation != null) {
    return { ok: false, status: 400, message: "send the full input; stored response state is not supported" };
  }
  if (record.background === true) {
    return { ok: false, status: 400, message: "background responses are not supported" };
  }
  const model = stringValue(record.model);
  if (!model) {
    return { ok: false, status: 400, message: "model is required" };
  }
  const messages: Array<Record<string, unknown>> = [];
  const instructions = stringValue(record.instructions);
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  const input = readInput(record.input);
  if (!input.ok) {
    return input;
  }
  messages.push(...input.messages);
  if (messages.length === 0) {
    return { ok: false, status: 400, message: "input is required" };
  }
  const effort = stringValue(record.reasoning_effort) ?? stringValue(recordValue(record.reasoning)?.effort);
  const maxOutput = finiteNumber(record.max_output_tokens);
  const temperature = finiteNumber(record.temperature);
  const topP = finiteNumber(record.top_p);
  return {
    ok: true,
    chat: {
      model,
      messages,
      ...(record.stream === true ? { stream: true } : {}),
      ...(maxOutput !== undefined ? { max_tokens: maxOutput } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    },
  };
}

export function chatSseToResponses(sse: string, model: string): string {
  const state = new ResponseState(model);
  for (const chunk of chatChunks(sse)) {
    state.push(chunk);
  }
  state.finish();
  return state.take();
}

export function streamChatToResponses(body: ReadableStream<Uint8Array> | null, model: string): ReadableStream<Uint8Array> | null {
  if (!body) {
    return null;
  }
  const state = new ResponseState(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const drained = takeChunks(pending);
      pending = drained.rest;
      for (const chunk of drained.chunks) {
        state.push(chunk);
      }
      const encoded = state.take();
      if (encoded) {
        controller.enqueue(encoder.encode(encoded));
      }
    },
    flush(controller) {
      pending += decoder.decode();
      const drained = takeChunks(`${pending}\n\n`);
      for (const chunk of drained.chunks) {
        state.push(chunk);
      }
      state.finish();
      const encoded = state.take();
      if (encoded) {
        controller.enqueue(encoder.encode(encoded));
      }
    },
  }));
}

export function chatJsonToResponse(payload: unknown, model: string): Record<string, unknown> {
  const root = recordValue(payload);
  const choice = recordValue(Array.isArray(root?.choices) ? root.choices[0] : undefined);
  const message = recordValue(choice?.message);
  const state = new ResponseState(stringValue(root?.model) || model);
  state.push({
    choices: [{
      delta: {
        ...(typeof message?.content === "string" ? { content: message.content } : {}),
        ...(typeof message?.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
      },
      finish_reason: stringValue(choice?.finish_reason) ?? "stop",
    }],
    ...(root?.usage ? { usage: root.usage } : {}),
  });
  state.finish();
  return state.snapshot("completed");
}

class ResponseState {
  readonly id = `resp_${randomBytes(12).toString("hex")}`;
  readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly events: Array<Record<string, unknown>> = [];
  private started = false;
  private text = "";
  private reasoning = "";
  private itemId = "";
  private usage?: Record<string, unknown>;

  constructor(readonly model: string) {}

  push(chunk: unknown): void {
    const root = recordValue(chunk);
    if (!root) {
      return;
    }
    const mapped = mapUsage(recordValue(root.usage));
    if (mapped) {
      this.usage = mapped;
    }
    const choice = recordValue(Array.isArray(root.choices) ? root.choices[0] : undefined);
    const delta = recordValue(choice?.delta);
    const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
    const content = typeof delta?.content === "string" ? delta.content : "";
    if (!reasoning && !content) {
      return;
    }
    this.ensureStarted();
    if (reasoning) {
      this.reasoning += reasoning;
    }
    if (!content) {
      return;
    }
    if (!this.itemId) {
      this.itemId = `msg_${randomBytes(6).toString("hex")}`;
      this.events.push({
        type: "response.output_item.added",
        output_index: 0,
        item: this.messageItem(""),
      });
      this.events.push({
        type: "response.content_part.added",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.text += content;
    this.events.push({
      type: "response.output_text.delta",
      item_id: this.itemId,
      output_index: 0,
      content_index: 0,
      delta: content,
    });
  }

  finish(): void {
    this.ensureStarted();
    if (this.itemId) {
      this.events.push({
        type: "response.output_text.done",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        text: this.text,
      });
      this.events.push({
        type: "response.output_item.done",
        output_index: 0,
        item: this.messageItem(this.text),
      });
    }
    this.events.push({ type: "response.completed", response: this.snapshot("completed") });
  }

  snapshot(status: string): Record<string, unknown> {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      model: this.model,
      status,
      output: this.itemId ? [this.messageItem(this.text)] : [],
      ...(this.reasoning ? { reasoning: { summary: this.reasoning } } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  take(): string {
    const encoded = this.events.map((event) => {
      const type = typeof event.type === "string" ? event.type : "response";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    }).join("");
    this.events.length = 0;
    return encoded;
  }

  private ensureStarted(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const response = this.snapshot("in_progress");
    this.events.push({ type: "response.created", response });
    this.events.push({ type: "response.in_progress", response });
  }

  private messageItem(text: string): Record<string, unknown> {
    return {
      type: "message",
      id: this.itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
  }
}

function readInput(input: unknown): { ok: true; messages: Array<Record<string, unknown>> } | { ok: false; status: number; message: string } {
  if (typeof input === "string") {
    return { ok: true, messages: input.trim() ? [{ role: "user", content: input }] : [] };
  }
  if (input == null) {
    return { ok: true, messages: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, status: 400, message: "input must be a string or an array" };
  }
  const messages: Array<Record<string, unknown>> = [];
  for (const entry of input) {
    const item = recordValue(entry);
    if (!item) {
      continue;
    }
    if (item.type === "item_reference") {
      return { ok: false, status: 400, message: "item references are not supported; send the full input" };
    }
    const role = stringValue(item.role) ?? (item.type === "message" ? "user" : undefined);
    if (!role) {
      continue;
    }
    messages.push({ role, content: chatContent(item.content ?? item.text) });
  }
  return { ok: true, messages };
}

function chatContent(content: unknown): unknown {
  if (typeof content === "string" || content == null) {
    return content ?? "";
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = content.flatMap((entry) => {
    const part = recordValue(entry);
    if (!part || typeof part.text !== "string") {
      return [];
    }
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    return [];
  });
  return parts;
}

function chatChunks(sse: string): unknown[] {
  return takeChunks(sse).chunks;
}

function takeChunks(sse: string): { chunks: unknown[]; rest: string } {
  const chunks: unknown[] = [];
  let rest = sse;
  for (;;) {
    const split = rest.indexOf("\n\n");
    if (split < 0) {
      return { chunks, rest };
    }
    const block = rest.slice(0, split);
    rest = rest.slice(split + 2);
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      chunks.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore non-JSON chat frames.
    }
  }
}

function mapUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }
  const input = finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.input_tokens) ?? 0;
  const output = finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens) ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: finiteNumber(usage.total_tokens) ?? input + output,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
