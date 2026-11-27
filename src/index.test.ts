import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { silentPluginLogger, type ProviderHandler } from "@viateai/sdk";
import {
  chatCompletions,
  exchangeOAuth,
  keepalive,
  listModels,
  normalizeCredentials,
  parseCredentials,
  plugin,
  startOAuth,
  subscription,
} from "./index.js";

const now = Math.floor(Date.now() / 1000);

describe("autoclaw plugin", () => {
  it("registers token and SMS auth", async () => {
    let handler: ProviderHandler | undefined;
    await plugin.register({
      registerProvider(registered) {
        handler = registered;
      },
      log: silentPluginLogger(),
    });
    assert.equal(plugin.id, "autoclaw");
    assert.equal(handler?.id, "autoclaw");
    const methods = (handler as { authMethods?: Array<{ id?: string; type?: string }> } | undefined)?.authMethods;
    assert.equal(methods?.[0]?.type, "credentials");
    assert.equal(methods?.[1]?.id, "sms");
    assert.equal(typeof handler?.chatCompletions, "function");
    assert.equal(typeof handler?.keepalive, "function");
  });

  it("normalizes a pasted credential file and a raw token", () => {
    assert.deepEqual(parseCredentials(" raw-token "), { accessToken: "raw-token" });
    const normalized = normalizeCredentials({
      access_token: "Bearer secret",
      refresh_token: "refresh",
      device_id: "device-1",
      user_id: "user-1",
      phone: "13800138000",
      region: "cn",
      expiresAt: 1_900_000_000,
    });
    assert.equal(normalized.displayLabel, "138****8000");
    assert.deepEqual(normalized.credentials, {
      region: "cn",
      accessToken: "secret",
      refreshToken: "refresh",
      deviceId: "device-1",
      userId: "user-1",
      phone: "13800138000",
      expiresAt: 1_900_000_000,
    });
    assert.throws(() => normalizeCredentials({ accessToken: "secret", refreshToken: "refresh" }), /deviceId is required/);
  });

  it("logs in with SMS and stores the device that received the code", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    await withFetch(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      seen.push({ url: String(url), body });
      if (String(url).includes("agent-send-code")) {
        return json({ code: 0, data: {} });
      }
      assert.equal(typeof body.code, "number");
      return json({
        code: 0,
        data: { access_token: "access", refresh_token: "refresh", user_id: "user-1", user_name: "Ada" },
      });
    }, async () => {
      const started = await startOAuth({
        connectionId: "c1",
        credentials: {},
        input: { phone: "13800138000" },
        callbackUrl: "http://localhost/callback",
      });
      assert.equal(started.type, "paste_code");
      const exchanged = await exchangeOAuth({ connectionId: "c1", credentials: {}, code: "457950", session: started.session });
      const credentials = exchanged.credentials as { accessToken: string; deviceId: string; phone: string };
      assert.equal(credentials.accessToken, "access");
      assert.equal(credentials.phone, "13800138000");
      assert.equal(credentials.deviceId, seen[0]?.body.device_id);
      assert.equal(seen[1]?.body.code, 457950);
    });
  });

  it("refreshes an expiring token and reports the point balance", async () => {
    await withFetch(async (url) => {
      const href = String(url);
      if (href.includes("/userapi/v1/refresh")) {
        return json({ code: 0, data: { access_token: "next-access", refresh_token: "next-refresh" } });
      }
      if (href.includes("/sandbox/list")) {
        return json({
          code: 0,
          data: {
            sandbox_list: [{
              sandbox_id: "sb",
              sandbox_endpoint: "wss://sandbox.example/autoclaw-cloud/ws?sandbox_id=sb",
              end_timestamp: now + 86_400,
            }],
          },
        });
      }
      if (href.includes("/wallets")) {
        return json({ code: 0, data: { total_balance: "25806" } });
      }
      return json({ code: 0, data: {} });
    }, async () => {
      const kept = await keepalive({
        connectionId: "refresh-1",
        credentials: {
          accessToken: "old",
          refreshToken: "old-refresh",
          deviceId: "device-1",
          region: "cn",
          expiresAt: now - 10,
        },
        signal: AbortSignal.timeout(5_000),
        reason: "timer",
        log: silentPluginLogger(),
      });
      assert.equal(kept.status, "ok");
      const credentials = kept.credentials as { accessToken: string; sandboxEndpoint: string };
      assert.equal(credentials.accessToken, "next-access");
      assert.equal(credentials.sandboxEndpoint, "https://sandbox.example/autoclaw-cloud/proxy/sb");
      const balance = await subscription({
        connectionId: "refresh-1",
        credentials,
        signal: AbortSignal.timeout(5_000),
        log: silentPluginLogger(),
      });
      assert.equal(balance.usages?.[0]?.remaining, 25806);
    });
  });

  it("passes a backend model through the sandbox OpenAI endpoint", async () => {
    const seen: Array<{ model?: string; header?: string | null }> = [];
    const server = await listen((req, res) => {
      if (req.url?.endsWith("/v1/chat/completions")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
          seen.push({ model: body.model, header: req.headers["x-openclaw-model"] as string | undefined });
          jsonReply(res, 200, { id: "chatcmpl-openai", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
        });
        return;
      }
      jsonReply(res, 200, {});
    });
    try {
      const exchange = await chatCompletions({
        body: { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
        headers: {},
      }, connection(server.origin));
      assert.equal(exchange.status, 200);
      assert.deepEqual(seen, [{ model: "openclaw", header: "glm-5.3-flash" }]);
      assert.match(await textBody(exchange.body), /ok/);
    } finally {
      await close(server.server);
    }
  });

  it("falls back to the relay when the OpenAI endpoint is disabled", async () => {
    let sent = "";
    let modelHeader = "";
    const server = await listen((req, res) => {
      if (req.url?.endsWith("/v1/chat/completions")) {
        jsonReply(res, 404, { error: "chatCompletions not enabled" });
        return;
      }
      if (req.url?.endsWith("/api/events")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.flushHeaders();
        eventsResponse = res;
        return;
      }
      if (req.url?.endsWith("/api/electron/agent/send")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          sent = Buffer.concat(chunks).toString();
          modelHeader = String(req.headers["x-openclaw-model"] ?? "");
          jsonReply(res, 200, { ok: true, data: { runId: "run-1" } });
          eventsResponse?.write(`data: ${JSON.stringify({ event: "agent:stream", payload: { runId: "run-1", type: "text", delta: "He" } })}\n\n`);
          eventsResponse?.write(`data: ${JSON.stringify({ event: "agent:stream", payload: { runId: "run-1", type: "text", delta: "Hello" } })}\n\n`);
          eventsResponse?.write(`data: ${JSON.stringify({ event: "agent:stream", payload: { runId: "run-1", type: "done", usage: { input: 4, output: 1, total: 5 } } })}\n\n`);
          eventsResponse?.end();
        });
        return;
      }
      jsonReply(res, 200, {});
    });
    try {
      const exchange = await chatCompletions({
        body: {
          model: "glm-5.2",
          stream: true,
          messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
        },
        headers: {},
        signal: AbortSignal.timeout(5_000),
      }, connection(server.origin, "relay-1"));
      assert.equal(exchange.status, 200);
      assert.equal(exchange.headers["content-type"], "text/event-stream");
      const body = await textBody(exchange.body);
      const content = [...body.matchAll(/"content":"([^"]*)"/g)].map((match) => match[1]).join("");
      assert.equal(content, "Hello");
      assert.match(body, /\[DONE\]/);
      assert.match(sent, /\[system\]/);
      assert.equal(modelHeader, "glm-5.2");
      const models = await listModels({ headers: {} }, connection(server.origin, "relay-1"));
      assert.ok(models.data.some((model) => model.id === "glm-5.3-flash"));
      const glm54 = models.data.find((model) => model.id === "glm-5.4");
      assert.equal(glm54?.name, "GLM-5.4");
      assert.equal(glm54?.context_length, 1_048_576);
    } finally {
      await close(server.server);
    }
  });
});

let eventsResponse: ServerResponse | undefined;

function connection(origin: string, connectionId = "openai-1") {
  return {
    connectionId,
    providerId: "autoclaw",
    credentials: {
      region: "cn",
      accessToken: "token",
      deviceId: "device-1",
      expiresAt: now + 86_400 * 20,
      sandboxId: "sb",
      sandboxEndpoint: `${origin}/autoclaw-cloud/proxy/sb`,
    },
  };
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => handler(req, res));
  server.on("upgrade", (_req, socket) => socket.destroy());
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

async function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

async function textBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  return new Response(body).text();
}

function close(server: Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  server.close((error) => error ? closed.reject(error) : closed.resolve());
  return closed.promise;
}
