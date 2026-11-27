import { createHash, randomBytes, randomUUID } from "node:crypto";

export const APP_ID = "100003";
export const APP_SECRET = "38d2391985e2369a5fb8227d8e6cd5e5";
export const CLIENT_VERSION = "1.12.1";
export const USER_API_CN = "https://autoglm-acceleration-api.zhipuai.cn";
export const USER_API_GLOBAL = "https://autoglm-api.autoglm.ai";
export const TOKEN_TTL_SECONDS = 28 * 24 * 60 * 60;
export const REFRESH_MARGIN_SECONDS = 2 * 24 * 60 * 60;
const CLOUD_SUFFIX = "/autoclaw-cloud";

export type Region = "cn" | "global";

export function userApiBase(region: Region): string {
  return region === "global" ? USER_API_GLOBAL : USER_API_CN;
}

export function sign(timestampSeconds: string): string {
  return createHash("md5").update(`${APP_ID}&${timestampSeconds}&${APP_SECRET}`).digest("hex");
}

export function bearerValue(token: string): string {
  const trimmed = token.trim();
  return trimmed.slice(0, 7).toLowerCase() === "bearer " ? trimmed : `Bearer ${trimmed}`;
}

export function stripBearer(token: string): string {
  const trimmed = token.trim();
  return trimmed.slice(0, 7).toLowerCase() === "bearer " ? trimmed.slice(7).trim() : trimmed;
}

export function userApiHeaders(accessToken?: string, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, string> {
  const timestamp = String(nowSeconds);
  const headers: Record<string, string> = {
    accept: "*/*",
    "content-type": "application/json",
    "x-auth-appid": APP_ID,
    "x-auth-sign": sign(timestamp),
    "x-auth-timestamp": timestamp,
    "x-channel": "official",
    "x-client-type": "web",
    "x-lang": "en",
    "x-product": "autoclaw",
    "x-tm": "web",
    "x-trace-id": randomBytes(16).toString("hex"),
    "x-version": CLIENT_VERSION,
  };
  if (accessToken) {
    headers.authorization = bearerValue(accessToken);
  }
  return headers;
}

export function relayHeaders(accessToken: string): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    authorization: bearerValue(accessToken),
  };
}

export function relayBase(endpoint: string): string {
  let value = endpoint.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("ws://")) {
    value = `http://${value.slice(5)}`;
  } else if (lower.startsWith("wss://")) {
    value = `https://${value.slice(6)}`;
  }
  if (!value.includes("://")) {
    const bare = value.replace(/\/+$/, "");
    return bare.endsWith(CLOUD_SUFFIX) ? bare : `${bare}${CLOUD_SUFFIX}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    const bare = value.replace(/\/+$/, "");
    return bare.endsWith(CLOUD_SUFFIX) ? bare : `${bare}${CLOUD_SUFFIX}`;
  }
  url.search = "";
  url.hash = "";
  const index = url.pathname.indexOf(CLOUD_SUFFIX);
  url.pathname = index >= 0
    ? url.pathname.slice(0, index + CLOUD_SUFFIX.length)
    : `${url.pathname.replace(/\/+$/, "")}${CLOUD_SUFFIX}`;
  return url.toString().replace(/\/+$/, "");
}

export function relayProxyBase(endpoint: string, sandboxId: string): string {
  const base = relayBase(endpoint).replace(/\/+$/, "");
  const id = sandboxId.trim();
  return id ? `${base}/proxy/${id}` : base;
}

export function relayBaseFromProxy(proxyBase: string): string {
  const value = proxyBase.replace(/\/+$/, "");
  const index = value.lastIndexOf("/proxy/");
  return index >= 0 ? value.slice(0, index) : value;
}

export function toWsBase(base: string): string {
  if (base.startsWith("https://")) {
    return `wss://${base.slice("https://".length)}`;
  }
  if (base.startsWith("http://")) {
    return `ws://${base.slice("http://".length)}`;
  }
  return base;
}

export function isAgentModel(model: string): boolean {
  const value = model.trim().toLowerCase();
  return value === "openclaw"
    || value === "openclaw/default"
    || value.startsWith("openclaw/")
    || value.startsWith("openclaw:")
    || value.startsWith("agent:");
}

export function newDeviceId(): string {
  return randomUUID();
}

export function freshSessionKey(): string {
  return `viate-${randomUUID()}`;
}
