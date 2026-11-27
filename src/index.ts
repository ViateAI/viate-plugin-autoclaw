import {
  definePlugin,
  modelList,
  parseOpenAIChatUsage,
  parseOpenAIResponsesUsage,
  type CredentialsWrite,
  type HttpExchange,
  type JsonGetRequest,
  type JsonPostRequest,
  type KeepaliveInput,
  type KeepaliveResult,
  type ModelList,
  type OAuthExchangeInput,
  type OAuthStartContext,
  type OAuthStartResult,
  type PluginContext,
  type ProviderConnection,
  type SubscriptionInput,
  type SubscriptionResult,
  type ViatePlugin,
} from "@viateai/sdk";
import {
  UpstreamError,
  completeChat,
  displayLabel,
  ensureSandbox,
  gatewayModels,
  login,
  needsRefresh,
  pointsBalance,
  readCredentials,
  refreshToken,
  sendCode,
  staticModels,
  toHttpExchange,
  type AutoClawCredentials,
} from "./client.js";
import { newDeviceId, REFRESH_MARGIN_SECONDS } from "./protocol.js";
import { chatJsonToResponse, responsesRequestToChat, streamChatToResponses } from "./responses.js";
import { recordValue, stringValue } from "./sse.js";

const PROVIDER_ID = "autoclaw";
const SUBSCRIPTION_DUE_MS = 30 * 60 * 1000;

type SmsStartContext = OAuthStartContext & {
  input?: Record<string, string>;
};

export type { AutoClawCredentials };

export const plugin: ViatePlugin = definePlugin({
  id: PROVIDER_ID,
  register(ctx: PluginContext) {
    const handler = {
      id: PROVIDER_ID,
      authMethods: [
        {
          id: "token",
          label: "Access token",
          type: "credentials",
          fields: [
            { key: "accessToken", label: "Access token", kind: "secret", required: true },
            { key: "refreshToken", label: "Refresh token", kind: "secret" },
            { key: "deviceId", label: "Device ID", kind: "string", description: "Required with a refresh token. Use the device id from the login that issued it." },
            {
              key: "region",
              label: "Region",
              kind: "select",
              options: [
                { label: "Mainland", value: "cn" },
                { label: "Global", value: "global" },
              ],
              defaultValue: "cn",
            },
          ],
        },
        {
          id: "sms",
          label: "SMS",
          type: "oauth",
          fields: [
            { key: "phone", label: "Phone", kind: "string", required: true, placeholder: "Mainland phone number" },
          ],
        },
      ],
      normalizeCredentials,
      startOAuth,
      exchangeOAuth,
      keepalive,
      subscription,
      chatCompletions,
      responses,
      listModels,
    };
    ctx.registerProvider(handler);
  },
});

export default plugin;

export function normalizeCredentials(input: unknown): CredentialsWrite {
  const credentials = readCredentials(input);
  return { credentials, displayLabel: displayLabel(credentials) };
}

export function parseCredentials(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("credentials are required");
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }
  return { accessToken: trimmed };
}

export async function startOAuth(ctx: SmsStartContext): Promise<OAuthStartResult> {
  const phone = stringValue(ctx.input?.phone);
  if (!phone) {
    throw new Error("phone is required");
  }
  const deviceId = newDeviceId();
  await sendCode("cn", deviceId, phone);
  return { type: "paste_code", session: { deviceId, phone, region: "cn" } };
}

export async function exchangeOAuth(input: OAuthExchangeInput): Promise<CredentialsWrite> {
  const session = recordValue(input.session);
  const deviceId = stringValue(session?.deviceId);
  const phone = stringValue(session?.phone);
  const code = stringValue(input.code);
  if (!deviceId || !phone || !code) {
    throw new Error("SMS login is missing the phone session or verification code");
  }
  const credentials = await login("cn", deviceId, phone, code);
  return { credentials, displayLabel: displayLabel(credentials) };
}

export async function keepalive(input: KeepaliveInput): Promise<KeepaliveResult> {
  try {
    let credentials = readCredentials(input.credentials);
    if (needsRefresh(credentials)) {
      credentials = await refreshToken(credentials, input.signal);
    }
    credentials = await ensureSandbox(input.connectionId, credentials, input.signal);
    return {
      status: "ok",
      credentials,
      displayLabel: displayLabel(credentials),
      nextDueMs: millisecondsUntilRefresh(credentials.expiresAt),
    };
  } catch (error) {
    return keepaliveFailure(error, input);
  }
}

export async function subscription(input: SubscriptionInput): Promise<SubscriptionResult> {
  try {
    const credentials = readCredentials(input.credentials);
    const remaining = await pointsBalance(credentials, input.signal);
    return {
      status: "ok",
      plan: "AutoClaw",
      nextDueMs: SUBSCRIPTION_DUE_MS,
      usages: [{
        type: "points",
        label: "Points",
        unit: "requests",
        used: null,
        limit: null,
        remaining,
        reported: true,
      }],
    };
  } catch (error) {
    const failed = keepaliveFailure(error, input);
    return { status: failed.status, ...(failed.error ? { error: failed.error } : {}), nextDueMs: SUBSCRIPTION_DUE_MS };
  }
}

export async function chatCompletions(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  try {
    const exchange = await completeChat({
      connectionId: connection.connectionId,
      credentials: readCredentials(connection.credentials),
      body: request.body,
      signal: request.signal,
    });
    return { ...exchange, parseUsage: parseOpenAIChatUsage };
  } catch (error) {
    return toHttpExchange(error);
  }
}

export async function responses(request: JsonPostRequest, connection: ProviderConnection): Promise<HttpExchange> {
  const converted = responsesRequestToChat(request.body);
  if (!converted.ok) {
    throw Object.assign(new Error(converted.message), { statusCode: converted.status });
  }
  const exchange = await chatCompletions({ ...request, body: converted.chat }, connection);
  if (exchange.status >= 400 || !exchange.body) {
    return exchange;
  }
  const model = converted.chat.model;
  if (converted.chat.stream === true) {
    return {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: streamChatToResponses(exchange.body, model),
      parseUsage: parseOpenAIResponsesUsage,
    };
  }
  const payload: unknown = JSON.parse(await new Response(exchange.body).text());
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: textStream(JSON.stringify(chatJsonToResponse(payload, model))),
    parseUsage: parseOpenAIResponsesUsage,
  };
}

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function listModels(request: JsonGetRequest, connection: ProviderConnection): Promise<ModelList> {
  const credentials = readCredentials(connection.credentials);
  const models = new Map(staticModels().map((model) => [model.id, model]));
  try {
    const sandbox = await ensureSandbox(connection.connectionId, credentials, request.signal);
    for (const id of await gatewayModels(sandbox, request.signal)) {
      if (!models.has(id)) {
        models.set(id, { id, name: id });
      }
    }
  } catch {
    // The static catalog is enough when the sandbox is asleep.
  }
  return modelList([...models.values()].map((model) => ({
    id: model.id,
    name: model.name,
    owned_by: "autoclaw",
    ...(model.context_length ? { context_length: model.context_length } : {}),
  })));
}

function millisecondsUntilRefresh(expiresAt: number): number {
  const due = (expiresAt - REFRESH_MARGIN_SECONDS) * 1000 - Date.now();
  return Math.max(60_000, due);
}

function keepaliveFailure(error: unknown, input: { log: KeepaliveInput["log"] }): KeepaliveResult {
  const dead = error instanceof UpstreamError && (error.status === 401 || error.code === 410000 || error.code === 410001);
  const status = dead ? "needs_reauth" : "failed";
  const message = error instanceof Error ? error.message : "AutoClaw request failed";
  input.log.warn({ status, error: message }, "autoclaw keepalive failed");
  return { status, error: message, ...(status === "failed" ? { nextDueMs: 60_000 } : {}) };
}
