import type { HttpExchange } from "@viateai/sdk";
import {
  TOKEN_TTL_SECONDS,
  bearerValue,
  freshSessionKey,
  isAgentModel,
  relayBaseFromProxy,
  relayHeaders,
  relayProxyBase,
  stripBearer,
  toWsBase,
  userApiBase,
  userApiHeaders,
  type Region,
} from "./protocol.js";
import { RelayConverter, completionFromSse, parseSseFrames, recordValue, stringValue } from "./sse.js";

const STATIC_MODELS = [
  { id: "glm-5.4", name: "GLM-5.4", context_length: 1_048_576 },
  { id: "glm-5.3", name: "GLM-5.3", context_length: 1_048_576 },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", context_length: 1_048_576 },
  { id: "glm-5.2", name: "GLM-5.2", context_length: 1_000_000 },
  { id: "zai_auto", name: "Auto" },
  { id: "openclaw", name: "OpenClaw" },
  { id: "openclaw/default", name: "OpenClaw default" },
] as const;
const sandboxes = new Map<string, SandboxCache>();

export type AutoClawCredentials = {
  region: Region;
  accessToken: string;
  refreshToken?: string;
  deviceId?: string;
  userId?: string;
  userName?: string;
  phone?: string;
  expiresAt: number;
  sandboxId?: string;
  sandboxEndpoint?: string;
  sandboxExpiresAt?: number;
};

type SandboxCache = {
  sandboxId: string;
  sandboxEndpoint: string;
  sandboxExpiresAt: number;
};

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 0,
  ) {
    super(message);
  }
}

export function readCredentials(value: unknown): AutoClawCredentials {
  const record = recordValue(value);
  if (!record) {
    throw new Error("credentials must be an object");
  }
  const accessToken = stripBearer(stringValue(record.accessToken) || stringValue(record.access_token) || "");
  if (!accessToken) {
    throw new Error("accessToken is required");
  }
  const refreshToken = stripBearer(stringValue(record.refreshToken) || stringValue(record.refresh_token) || "");
  const deviceId = stringValue(record.deviceId) || stringValue(record.device_id);
  if (refreshToken && !deviceId) {
    throw new Error("deviceId is required when refreshToken is set");
  }
  const region = stringValue(record.region) === "global" ? "global" : "cn";
  const expiresAt = unixSeconds(record.expiresAt ?? record.expires_at) ?? Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  return {
    region,
    accessToken,
    expiresAt,
    ...(refreshToken ? { refreshToken } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(stringValue(record.userId) || stringValue(record.user_id) ? { userId: stringValue(record.userId) || stringValue(record.user_id) } : {}),
    ...(stringValue(record.userName) || stringValue(record.user_name) ? { userName: stringValue(record.userName) || stringValue(record.user_name) } : {}),
    ...(stringValue(record.phone) ? { phone: stringValue(record.phone) } : {}),
    ...(stringValue(record.sandboxId) || stringValue(record.sandbox_id) ? { sandboxId: stringValue(record.sandboxId) || stringValue(record.sandbox_id) } : {}),
    ...(stringValue(record.sandboxEndpoint) || stringValue(record.sandbox_endpoint) ? { sandboxEndpoint: stringValue(record.sandboxEndpoint) || stringValue(record.sandbox_endpoint) } : {}),
    ...((unixSeconds(record.sandboxExpiresAt ?? record.endTimestamp ?? record.end_timestamp) ?? 0) > 0
      ? { sandboxExpiresAt: unixSeconds(record.sandboxExpiresAt ?? record.endTimestamp ?? record.end_timestamp) }
      : {}),
  };
}

export function displayLabel(credentials: AutoClawCredentials): string {
  if (credentials.phone && credentials.phone.length >= 7) {
    return `${credentials.phone.slice(0, 3)}****${credentials.phone.slice(-4)}`;
  }
  return credentials.userName || credentials.userId || credentials.region;
}

export function needsRefresh(credentials: AutoClawCredentials, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return credentials.expiresAt - nowSeconds <= 2 * 24 * 60 * 60;
}

export async function sendCode(region: Region, deviceId: string, phone: string, signal?: AbortSignal): Promise<void> {
  await userApi(region, undefined, "POST", "/userapi/v1/agent-send-code", {
    source_id: "autoclaw",
    device_id: deviceId,
    phone,
  }, signal);
}

export async function login(region: Region, deviceId: string, phone: string, code: string, signal?: AbortSignal): Promise<AutoClawCredentials> {
  const parsed = Number(code.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("verification code must be a number");
  }
  const data = await userApi(region, undefined, "POST", "/userapi/v1/agent-login/", {
    source_id: "autoclaw",
    device_id: deviceId,
    phone,
    code: parsed,
    platform: "web",
  }, signal);
  const accessToken = stringValue(data.access_token);
  if (!accessToken) {
    throw new Error("login response did not include an access token");
  }
  return readCredentials({
    region,
    accessToken,
    refreshToken: stringValue(data.refresh_token),
    deviceId,
    userId: stringValue(data.user_id),
    userName: stringValue(data.user_name),
    phone,
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  });
}

export async function refreshToken(credentials: AutoClawCredentials, signal?: AbortSignal): Promise<AutoClawCredentials> {
  if (!credentials.refreshToken || !credentials.deviceId) {
    throw new UpstreamError("AutoClaw session expired", 401, 410001);
  }
  const data = await userApi(credentials.region, credentials.accessToken, "POST", "/userapi/v1/refresh", {
    source_id: "autoclaw",
    device_id: credentials.deviceId,
    refresh_token: credentials.refreshToken,
  }, signal);
  const accessToken = stringValue(data.access_token);
  if (!accessToken) {
    throw new UpstreamError("AutoClaw token refresh failed", 401, 410001);
  }
  return {
    ...credentials,
    accessToken: stripBearer(accessToken),
    refreshToken: stripBearer(stringValue(data.refresh_token) || credentials.refreshToken),
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
}

export async function pointsBalance(credentials: AutoClawCredentials, signal?: AbortSignal): Promise<number> {
  const data = await userApi(
    credentials.region,
    credentials.accessToken,
    "GET",
    "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw",
    undefined,
    signal,
  );
  return balance(data.total_balance);
}

export async function completeChat(options: {
  connectionId: string;
  credentials: AutoClawCredentials;
  body: unknown;
  signal?: AbortSignal;
}): Promise<HttpExchange> {
  const sandbox = await ensureSandbox(options.connectionId, options.credentials, options.signal);
  await wakeSandbox(sandbox, options.signal);
  const openAI = await postOpenAI(sandbox, options.body, options.signal);
  if (openAI) {
    return openAI;
  }
  return postRelay(sandbox, options.body, options.signal);
}

export async function gatewayModels(credentials: AutoClawCredentials, signal?: AbortSignal): Promise<string[]> {
  if (!credentials.sandboxEndpoint) {
    return [];
  }
  const response = await fetch(`${credentials.sandboxEndpoint}/v1/models`, {
    headers: relayHeaders(credentials.accessToken),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return [];
  }
  const payload = recordValue(await response.json().catch(() => undefined));
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.flatMap((entry) => {
    const id = stringValue(recordValue(entry)?.id);
    return id ? [id] : [];
  });
}

export function toHttpExchange(error: unknown): HttpExchange {
  if (error instanceof UpstreamError) {
    const status = error.status === 401 || error.code === 410000 || error.code === 410001
      ? 401
      : error.status === 402
        ? 402
        : error.status === 429
          ? 429
          : error.status >= 400 && error.status < 500
            ? error.status
            : 502;
    return jsonExchange(status, error.message);
  }
  return jsonExchange(502, error instanceof Error ? error.message : "AutoClaw request failed");
}

export function staticModels(): ReadonlyArray<{ id: string; name: string; context_length?: number }> {
  return STATIC_MODELS;
}

export async function ensureSandbox(connectionId: string, credentials: AutoClawCredentials, signal?: AbortSignal): Promise<AutoClawCredentials> {
  const now = Math.floor(Date.now() / 1000);
  const cached = sandboxes.get(connectionId);
  const fromCredentials = usableSandbox(credentials, now);
  const known = fromCredentials ?? (cached && cached.sandboxExpiresAt > now ? cached : undefined);
  if (known) {
    const endpoint = relayProxyBase(known.sandboxEndpoint, known.sandboxId);
    const next = { ...credentials, sandboxId: known.sandboxId, sandboxEndpoint: endpoint, sandboxExpiresAt: known.sandboxExpiresAt };
    sandboxes.set(connectionId, { sandboxId: known.sandboxId, sandboxEndpoint: endpoint, sandboxExpiresAt: known.sandboxExpiresAt });
    return next;
  }
  let list = await listSandboxes(credentials, signal);
  if (list.length === 0) {
    await userApi(credentials.region, credentials.accessToken, "POST", "/agentdr/v2/assistant/sandbox/apply", { sandbox_name: "default" }, signal);
    list = await listSandboxes(credentials, signal);
  }
  const pick = list.find((item) => item.end === 0 || item.end > now) ?? list[0];
  if (!pick?.id || !pick.endpoint) {
    throw new UpstreamError("AutoClaw sandbox is not available", 502);
  }
  const endpoint = relayProxyBase(pick.endpoint, pick.id);
  sandboxes.set(connectionId, { sandboxId: pick.id, sandboxEndpoint: endpoint, sandboxExpiresAt: pick.end });
  return { ...credentials, sandboxId: pick.id, sandboxEndpoint: endpoint, sandboxExpiresAt: pick.end };
}

function usableSandbox(credentials: AutoClawCredentials, now: number): SandboxCache | undefined {
  if (!credentials.sandboxId || !credentials.sandboxEndpoint) {
    return undefined;
  }
  if (credentials.sandboxExpiresAt && credentials.sandboxExpiresAt <= now) {
    return undefined;
  }
  return {
    sandboxId: credentials.sandboxId,
    sandboxEndpoint: credentials.sandboxEndpoint,
    sandboxExpiresAt: credentials.sandboxExpiresAt ?? 0,
  };
}

async function listSandboxes(credentials: AutoClawCredentials, signal?: AbortSignal): Promise<Array<{ id: string; endpoint: string; end: number }>> {
  const data = await userApi(credentials.region, credentials.accessToken, "GET", "/agentdr/v2/assistant/sandbox/list", undefined, signal);
  const list = Array.isArray(data.sandbox_list) ? data.sandbox_list : [];
  return list.flatMap((entry) => {
    const record = recordValue(entry);
    const id = stringValue(record?.sandbox_id);
    const endpoint = stringValue(record?.sandbox_endpoint);
    if (!record || !id || !endpoint) {
      return [];
    }
    return [{ id, endpoint, end: balance(record.end_timestamp) }];
  });
}

async function wakeSandbox(credentials: AutoClawCredentials, signal?: AbortSignal): Promise<void> {
  if (!credentials.sandboxId || !credentials.sandboxEndpoint) {
    return;
  }
  const bare = relayBaseFromProxy(credentials.sandboxEndpoint);
  try {
    const response = await fetch(`${bare}/v1/sandboxes/${encodeURIComponent(credentials.sandboxId)}/wake`, {
      method: "POST",
      headers: { ...relayHeaders(credentials.accessToken), "content-type": "application/json" },
      body: JSON.stringify({
        access_hold_ms: 600_000,
        reason: "viate chat request",
        apply_business_busy_cooldown: true,
      }),
      signal,
    });
    await response.body?.cancel();
  } catch {
    // A sleeping sandbox still answers the proxy once the device websocket is up.
  }
}

async function postOpenAI(credentials: AutoClawCredentials, body: unknown, signal?: AbortSignal): Promise<HttpExchange | undefined> {
  const prepared = prepareOpenAIBody(body);
  let response: Response;
  try {
    response = await fetch(`${credentials.sandboxEndpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...relayHeaders(credentials.accessToken),
        "content-type": "application/json",
        ...(prepared.modelHeader ? { "x-openclaw-model": prepared.modelHeader } : {}),
        ...(prepared.sessionHeader ? { "x-openclaw-session-key": prepared.sessionHeader } : {}),
      },
      body: JSON.stringify(prepared.body),
      signal,
    });
  } catch {
    return undefined;
  }
  if (response.status === 404 || response.status === 501) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.status === 400) {
    const text = await response.text();
    const disabled = ["chatcompletions", "endpoint", "not enabled", "disabled"].some((needle) => text.toLowerCase().includes(needle));
    if (disabled) {
      return undefined;
    }
    return jsonExchange(400, text.slice(0, 300) || "AutoClaw rejected the chat request");
  }
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  }
  const cache = response.headers.get("cache-control");
  if (cache) {
    headers["cache-control"] = cache;
  }
  return { status: response.status, headers, body: response.body };
}

function prepareOpenAIBody(body: unknown): { body: unknown; modelHeader?: string; sessionHeader?: string } {
  const record = recordValue(body) ?? {};
  const model = stringValue(record.model) || "openclaw";
  const user = stringValue(record.user);
  const sessionHeader = user && !/^(subagent:|cron:|acp:)/i.test(user) ? `webchat:viate:${user}` : undefined;
  if (isAgentModel(model)) {
    return { body: { ...record, model }, ...(sessionHeader ? { sessionHeader } : {}) };
  }
  return {
    body: { ...record, model: "openclaw" },
    modelHeader: model,
    ...(sessionHeader ? { sessionHeader } : {}),
  };
}

async function postRelay(credentials: AutoClawCredentials, body: unknown, signal?: AbortSignal): Promise<HttpExchange> {
  const record = recordValue(body) ?? {};
  const requestedModel = stringValue(record.model) || "openclaw";
  const user = stringValue(record.user);
  const stableSession = Boolean(user) && !/^(subagent:|cron:|acp:)/i.test(user ?? "");
  const session = stableSession ? user ?? freshSessionKey() : freshSessionKey();
  const message = stableSession ? lastUserText(record.messages) : renderTranscript(record.messages);
  if (!message) {
    return jsonExchange(400, "no user text message found");
  }
  const closeDevice = await connectDevice(credentials, signal);
  try {
    const events = await fetch(`${credentials.sandboxEndpoint}/api/events`, {
      headers: { ...relayHeaders(credentials.accessToken), accept: "text/event-stream" },
      signal,
    });
    if (events.status >= 400) {
      return jsonExchange(upstreamStatus(events.status), `AutoClaw event stream failed (${events.status})`);
    }
    const send = await fetch(`${credentials.sandboxEndpoint}/api/electron/agent/send`, {
      method: "POST",
      headers: {
        ...relayHeaders(credentials.accessToken),
        "content-type": "application/json",
        ...(isAgentModel(requestedModel) ? {} : { "x-openclaw-model": requestedModel }),
      },
      body: JSON.stringify({
        args: [{
          sessionKey: session,
          message,
          ...(stringValue(record.reasoning_effort) ? { thinking: stringValue(record.reasoning_effort) } : {}),
        }],
      }),
      signal,
    });
    const sendText = await send.text();
    if (send.status >= 400) {
      return jsonExchange(upstreamStatus(send.status, sendText), sendText.slice(0, 300) || `AutoClaw agent send failed (${send.status})`);
    }
    const runId = extractRunId(sendText);
    const converter = new RelayConverter({ runId, session, model: requestedModel });
    const sse = await readRelayEvents(events, converter, signal);
    if (record.stream === true) {
      return {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: streamOf(sse),
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: streamOf(completionFromSse(sse, requestedModel)),
    };
  } finally {
    closeDevice();
  }
}

async function readRelayEvents(response: Response, converter: RelayConverter, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    converter.finish();
    return converter.take();
  }
  const decoder = new TextDecoder();
  let pending = "";
  const pieces: string[] = [];
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!converter.done) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let split = pending.indexOf("\n\n");
      while (split >= 0) {
        const block = pending.slice(0, split);
        pending = pending.slice(split + 2);
        for (const frame of parseSseFrames(`${block}\n\n`)) {
          converter.pushFrame(frame);
        }
        const taken = converter.take();
        if (taken) {
          pieces.push(taken);
        }
        if (converter.done) {
          break;
        }
        split = pending.indexOf("\n\n");
      }
      if (chunk.done) {
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
  if (!converter.done) {
    converter.finish();
    pieces.push(converter.take());
  }
  return pieces.join("");
}

async function connectDevice(credentials: AutoClawCredentials, signal?: AbortSignal): Promise<() => void> {
  if (!credentials.sandboxEndpoint?.includes("/proxy/") || !credentials.sandboxId) {
    return () => undefined;
  }
  const token = stripBearer(credentials.accessToken);
  const url = new URL(`${toWsBase(relayBaseFromProxy(credentials.sandboxEndpoint))}/v1/client/ws`);
  url.searchParams.set("device_id", credentials.sandboxId);
  url.searchParams.set("access_token", token);
  const socket = new WebSocket(url);
  const opened = Promise.withResolvers<void>();
  const timer = setTimeout(() => opened.reject(new Error("device websocket timed out")), 8_000);
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    opened.resolve();
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    opened.reject(new Error("device websocket failed"));
  }, { once: true });
  socket.addEventListener("close", () => {
    clearTimeout(timer);
    opened.reject(new Error("device websocket closed"));
  }, { once: true });
  try {
    await opened.promise;
    socket.send(JSON.stringify({
      type: "auth.inject",
      token,
      ...(credentials.userId ? { userId: credentials.userId } : {}),
      ...(credentials.userName ? { userName: credentials.userName } : {}),
      clientMetadata: { client_type: "web" },
    }));
    await waitForInject(socket);
  } catch {
    socket.close();
    return () => undefined;
  }
  const close = () => socket.close();
  signal?.addEventListener("abort", close, { once: true });
  return () => {
    signal?.removeEventListener("abort", close);
    socket.close();
  };
}

function waitForInject(socket: WebSocket): Promise<void> {
  const result = Promise.withResolvers<void>();
  const timer = setTimeout(() => result.reject(new Error("auth.inject timed out")), 8_000);
  socket.addEventListener("message", (event) => {
    const record = recordValue(parseJson(String(event.data)));
    if (record?.type === "auth.inject.ok") {
      clearTimeout(timer);
      result.resolve();
    } else if (record?.type === "auth.inject.error") {
      clearTimeout(timer);
      result.reject(new Error("auth.inject failed"));
    }
  });
  return result.promise;
}

function renderTranscript(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  const blocks: string[] = [];
  for (const entry of messages) {
    const record = recordValue(entry);
    const role = stringValue(record?.role);
    const text = messageText(record?.content);
    if (!record || !role || !text) {
      continue;
    }
    blocks.push(`[${role}]\n${text}`);
  }
  return blocks.join("\n\n");
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = recordValue(messages[index]);
    if (stringValue(record?.role) !== "user") {
      continue;
    }
    const text = messageText(record?.content);
    if (text) {
      return text;
    }
  }
  return "";
}

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.flatMap((part) => {
    const record = recordValue(part);
    return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("").trim();
}

async function userApi(
  region: Region,
  accessToken: string | undefined,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${userApiBase(region)}${path}`, {
    method,
    headers: userApiHeaders(accessToken),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const text = await response.text();
  if (response.status >= 400) {
    throw new UpstreamError(text.slice(0, 200) || `AutoClaw request failed (${response.status})`, response.status);
  }
  const parsed = recordValue(parseJson(text));
  if (!parsed) {
    throw new UpstreamError("AutoClaw response was not JSON", 502);
  }
  const code = typeof parsed.code === "number" ? parsed.code : 0;
  if (code !== 0) {
    throw new UpstreamError(stringValue(parsed.msg) || `AutoClaw error ${code}`, response.status, code);
  }
  return recordValue(parsed.data) ?? {};
}

function extractRunId(text: string): string {
  const parsed = parseJson(text);
  if (typeof parsed === "string") {
    return parsed.trim();
  }
  const record = recordValue(parsed);
  const data = recordValue(record?.data) ?? record;
  return stringValue(data?.runId) || stringValue(data?.run_id) || "";
}

function upstreamStatus(status: number, body = ""): number {
  if (status === 401 || body.includes("410001") || body.includes("410000")) {
    return 401;
  }
  if (status === 402 || /余额不足|insufficient/i.test(body)) {
    return 402;
  }
  if (status === 429) {
    return 429;
  }
  return status >= 400 && status < 500 ? status : 502;
}

function jsonExchange(status: number, message: string): HttpExchange {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: streamOf(JSON.stringify({ error: { message, type: "upstream_error" } })),
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function unixSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.trunc(numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed / 1000);
    }
  }
  return undefined;
}

function balance(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

