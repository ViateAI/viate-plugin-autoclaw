# @viateai/plugin-autoclaw

Viate provider for one [AutoClaw](https://autoclaw.z.ai/) account. Chat requests spend that account's points. Viate connections are the account pool: add one connection per account.

Protocol notes come from [ZFXing-lite/autoclaw2api](https://github.com/ZFXing-lite/autoclaw2api). This package does not run that gateway.

## Auth

- **SMS** (mainland): phone number, then the verification code.
- **Access token**: paste `accessToken`, and `refreshToken` plus `deviceId` when you have them. `region` is `cn` or `global`. A JSON object from an `autoclaw-*.json` credential file is accepted.

Global accounts use Z.AI / Google OAuth in the AutoClaw web app. Paste the resulting token; this plugin does not open that OAuth page.

## Calls

`chatCompletions` and `responses` both reach the sandbox. `responses` is translated to a chat completion. Backend model ids (`glm-5.4`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `zai_auto`) are sent as `x-openclaw-model`. If the OpenAI endpoint is disabled, the plugin falls back to the web relay (`agent/send` plus the device websocket).

Relay fallback is an agent bridge, not a raw token stream:

- a request with `user` continues that sandbox session and sends only the latest user text
- a request without `user` opens a fresh session and sends the whole transcript

`listModels` publishes the current AutoClaw built-ins (`glm-5.4`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `zai_auto` / Auto) plus the `openclaw` agent ids. The sandbox `/v1/models` route only lists agents, so it does not replace this catalog. Subscription reports the wallet point balance.

Token refresh and sandbox discovery run from keepalive and are written back onto the connection.

## Install

This package is not published to npm. Clone the repository, compile it, and install that directory. `viate.entry` is `dist/index.js`, and `dist/` is not in git. The installer runs with `ignore-scripts=true`, so it will not compile the package for you.

Node.js >= 24. pnpm 12.16.1, pinned by `packageManager`.

```bash
git clone https://github.com/ViateAI/viate-plugin-autoclaw.git
cd viate-plugin-autoclaw
pnpm install
pnpm build
viate plugin add "$PWD"
```

`$PWD` is passed to `pnpm add` by the `viate` process. From the admin plugin source field, use the same directory as an absolute path that process can read.

`@viateai/sdk` is a peer of `1.0.1`; the gateway removes it at install and loads its own copy. `plugin add` stages a pending workspace. Restart the gateway to load it.

To install a newer checkout, pull, run `pnpm install` and `pnpm build` again, then `viate plugin add "$PWD"` again, and restart.

Plugins run in-process. Install only packages you trust. See [Viate](https://github.com/ViateAI/viate).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Release Please on `main` owns the version and changelog. Do not edit either by hand.

Unofficial client. Use it with an account you control, and follow AutoClaw / Z.AI's terms. Do not resell access.

MIT. See [LICENSE](LICENSE).
