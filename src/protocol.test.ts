import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAgentModel, relayBase, relayProxyBase, sign } from "./protocol.js";

describe("autoclaw protocol", () => {
  it("signs the web client timestamp", () => {
    assert.equal(sign("1700000000"), "2586ea4cc4191242c9acdc2ee7e96ac8");
  });

  it("normalizes a sandbox websocket endpoint to the cloud proxy base", () => {
    const endpoint = "wss://autoglm-api.zhipuai.cn/autoclaw-cloud/ws?sandbox_id=sb&port=1&path=/ws";
    assert.equal(relayBase(endpoint), "https://autoglm-api.zhipuai.cn/autoclaw-cloud");
    assert.equal(
      relayProxyBase(endpoint, "cloud-sb-1"),
      "https://autoglm-api.zhipuai.cn/autoclaw-cloud/proxy/cloud-sb-1",
    );
  });

  it("treats openclaw agent names separately from backend models", () => {
    assert.equal(isAgentModel("openclaw/default"), true);
    assert.equal(isAgentModel("agent:main"), true);
    assert.equal(isAgentModel("glm-5.3-flash"), false);
  });
});
