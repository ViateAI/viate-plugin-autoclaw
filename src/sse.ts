export type RelayFrame = {
  event: string;
  payload: Record<string, unknown>;
};

type ConverterOptions = {
  runId: string;
  session: string;
  model: string;
  id?: string;
  created?: number;
};

type ToolCall = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

export class RelayConverter {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  private readonly runId: string;
  private readonly session: string;
  private lastText = "";
  private toolSeq = 0;
  private readonly seenTools = new Set<string>();
  private finished = false;
  private readonly chunks: string[] = [];

  constructor(options: ConverterOptions) {
    this.runId = options.runId;
    this.session = options.session;
    this.model = options.model || "openclaw";
    this.id = options.id ?? `chatcmpl-${Date.now()}`;
    this.created = options.created ?? Math.floor(Date.now() / 1000);
  }

  get done(): boolean {
    return this.finished;
  }

  pushFrame(frame: RelayFrame): void {
    if (this.finished || !ownsFrame(frame.payload, this.runId, this.session)) {
      return;
    }
    const event = frame.event;
    if (event === "chat") {
      this.handleChat(frame.payload);
      return;
    }
    if (event === "agent") {
      this.handleAgent(frame.payload);
      return;
    }
    if (event === "agent:stream" || event === "stream" || event === "chat:message" || event === "chat.delta") {
      this.handleAgentStream(frame.payload);
    }
  }

  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.chunks.push("data: [DONE]\n\n");
  }

  take(): string {
    const text = this.chunks.join("");
    this.chunks.length = 0;
    return text;
  }

  private handleAgentStream(payload: Record<string, unknown>): void {
    const type = stringValue(payload.type);
    if (type === "error") {
      this.emitError(payloadMessage(payload));
      return;
    }
    if (type === "done") {
      this.emitUsageAndDone(extractUsage(payload));
      return;
    }
    if (type === "text") {
      this.emitText(stringValue(payload.delta) || stringValue(payload.text) || "");
      return;
    }
    if (type === "thinking") {
      this.emitThinking(stringValue(payload.text) || stringValue(payload.delta) || "");
      return;
    }
    if (type === "tool_call" || type === "tool_use") {
      const name = stringValue(payload.name) || stringValue(payload.tool) || "";
      if (name) {
        this.emitToolUse(stringValue(payload.id) || "", name, payload.input ?? payload.arguments);
      }
      return;
    }
    const message = recordValue(payload.message);
    if (!message) {
      return;
    }
    if (typeof message.content === "string") {
      this.emitText(message.content);
      return;
    }
    if (Array.isArray(message.content)) {
      this.emitContentParts(message.content);
    }
  }

  private handleChat(payload: Record<string, unknown>): void {
    const state = stringValue(payload.state);
    if (state === "error") {
      this.emitError(payloadMessage(payload));
      return;
    }
    const message = recordValue(payload.message);
    if (!message) {
      if (state === "final" && extractUsage(payload)) {
        this.emitUsageAndDone(extractUsage(payload));
      }
      return;
    }
    if (typeof message.content === "string") {
      this.emitText(message.content);
    } else if (Array.isArray(message.content)) {
      this.emitContentParts(message.content);
    }
    if (Array.isArray(message.toolCalls)) {
      for (const entry of message.toolCalls) {
        const tool = recordValue(entry);
        if (!tool) {
          continue;
        }
        const fn = recordValue(tool.function);
        const name = stringValue(tool.name) || stringValue(fn?.name) || "";
        if (name) {
          this.emitToolUse(stringValue(tool.id) || "", name, tool.input ?? tool.arguments);
        }
      }
    }
    if (state === "final") {
      this.emitUsageAndDone(extractUsage(recordValue(payload.usage) ?? payload));
    }
  }

  private handleAgent(payload: Record<string, unknown>): void {
    const stream = stringValue(payload.stream);
    const data = recordValue(payload.data) ?? payload;
    if (stream === "assistant") {
      if (Array.isArray(data.content)) {
        this.emitContentParts(data.content);
        return;
      }
      if (Array.isArray(data.blocks)) {
        this.emitContentParts(data.blocks);
        return;
      }
      this.emitText(stringValue(data.text) || stringValue(data.delta) || "");
      return;
    }
    if (stream === "tool" && stringValue(data.phase) === "start") {
      const name = stringValue(data.name) || "";
      if (name) {
        this.emitToolUse(stringValue(data.toolCallId) || "", name, data.args ?? data.input);
      }
      return;
    }
    if (stream === "lifecycle") {
      const phase = stringValue(data.phase);
      if (phase === "end") {
        this.emitUsageAndDone(extractUsage(recordValue(data.usage) ?? payload));
      } else if (phase === "error") {
        this.emitError(payloadMessage(data));
      }
      return;
    }
    if (stream === "error") {
      this.emitError(payloadMessage(data));
    }
  }

  private emitContentParts(parts: unknown[]): void {
    for (const part of parts) {
      const record = recordValue(part);
      if (!record) {
        continue;
      }
      const type = stringValue(record.type);
      if (type === "text") {
        this.emitText(stringValue(record.text) || "");
      } else if (type === "thinking") {
        this.emitThinking(stringValue(record.thinking) || "");
      } else if ((type === "tool_use" || type === "toolCall") && stringValue(record.name)) {
        this.emitToolUse(stringValue(record.id) || "", stringValue(record.name) || "", record.input ?? record.arguments);
      }
    }
  }

  private emitText(text: string): void {
    if (!text || text === this.lastText) {
      return;
    }
    const delta = text.startsWith(this.lastText) ? text.slice(this.lastText.length) : text;
    this.lastText = text;
    if (!delta) {
      return;
    }
    this.emitChunk({
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    });
  }

  private emitThinking(text: string): void {
    if (!text) {
      return;
    }
    this.emitChunk({
      choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
    });
  }

  private emitToolUse(id: string, name: string, input: unknown): void {
    const toolId = id || `${name}-${this.toolSeq}`;
    if (this.seenTools.has(toolId)) {
      return;
    }
    this.seenTools.add(toolId);
    const index = this.toolSeq;
    this.toolSeq += 1;
    const call: ToolCall = {
      index,
      id: toolId,
      name,
      arguments: input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input),
    };
    this.emitChunk({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: call.index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          }],
        },
        finish_reason: null,
      }],
    });
  }

  private emitUsageAndDone(usage: Record<string, unknown> | undefined): void {
    const chunk: Record<string, unknown> = {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    if (usage) {
      const prompt = numberValue(usage.input ?? usage.prompt_tokens ?? usage.inputTokens);
      const completion = numberValue(usage.output ?? usage.completion_tokens ?? usage.outputTokens);
      const total = numberValue(usage.total ?? usage.total_tokens ?? usage.totalTokens) || prompt + completion;
      chunk.usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
    }
    this.emitChunk(chunk);
    this.finish();
  }

  private emitError(message: string): void {
    if (message) {
      this.emitText(message);
    }
    this.emitChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    this.finish();
  }

  private emitChunk(chunk: Record<string, unknown>): void {
    chunk.id = this.id;
    chunk.object = "chat.completion.chunk";
    chunk.created = this.created;
    chunk.model = this.model;
    this.chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
}

export function parseSseFrames(raw: string): RelayFrame[] {
  const frames: RelayFrame[] = [];
  for (const block of raw.split(/\n\n/)) {
    if (!block.trim()) {
      continue;
    }
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    if (!data) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    const record = recordValue(parsed);
    if (!record) {
      continue;
    }
    const payload = recordValue(record.payload) ?? record;
    frames.push({ event: stringValue(record.event) || event, payload });
  }
  return frames;
}

export function completionFromSse(sse: string, model: string): string {
  let content = "";
  let reasoning = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  let usage: unknown;
  let finish = "stop";
  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  for (const block of sse.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "));
    if (!line) {
      continue;
    }
    const data = line.slice(6);
    if (data === "[DONE]") {
      continue;
    }
    let chunk: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      const record = recordValue(parsed);
      if (!record) {
        continue;
      }
      chunk = record;
    } catch {
      continue;
    }
    if (typeof chunk.id === "string") {
      id = chunk.id;
    }
    if (typeof chunk.created === "number") {
      created = chunk.created;
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
    const choice = Array.isArray(chunk.choices) ? recordValue(chunk.choices[0]) : undefined;
    const delta = recordValue(choice?.delta);
    if (typeof delta?.content === "string") {
      content += delta.content;
    }
    if (typeof delta?.reasoning_content === "string") {
      reasoning += delta.reasoning_content;
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const entry of delta.tool_calls) {
        const tool = recordValue(entry);
        if (tool) {
          toolCalls.push(tool);
        }
      }
    }
    if (typeof choice?.finish_reason === "string") {
      finish = choice.finish_reason;
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) {
    message.reasoning_content = reasoning;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
}

function ownsFrame(payload: Record<string, unknown>, runId: string, session: string): boolean {
  const eventRun = stringValue(payload.runId) || "";
  const sessionKey = stringValue(payload.sessionKey) || "";
  const to = stringValue(payload.to) || "";
  const sameRun = Boolean(eventRun && runId && eventRun === runId);
  const sameSession = (sessionKey !== "" && sessionKey === session) || (to !== "" && to === session);
  return sameRun || (sameSession && eventRun === "");
}

function payloadMessage(payload: Record<string, unknown>): string {
  for (const key of ["message", "error", "msg", "detail", "text", "delta"]) {
    const value = stringValue(payload[key]);
    if (value) {
      return value;
    }
  }
  return "agent request failed";
}

function extractUsage(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const nested = recordValue(value.usage);
  if (nested && hasUsage(nested)) {
    return nested;
  }
  if (hasUsage(value)) {
    return value;
  }
  const result = recordValue(value.result);
  if (!result) {
    return undefined;
  }
  return hasUsage(result) ? result : recordValue(result.usage);
}

function hasUsage(value: Record<string, unknown>): boolean {
  return ["input", "output", "total", "inputTokens", "outputTokens", "prompt_tokens", "completion_tokens", "total_tokens"].some((key) => key in value);
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }
  return 0;
}
