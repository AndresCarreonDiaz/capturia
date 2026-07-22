# Hosted tier: LLM proxy + entitlements (M11 slice 1)

The backbone of Capturia Pro, built to the architecture decided on issue #10:
Stripe for billing (test mode until launch), the LLM proxy as a Vercel
function inside this Next.js app, Cloudflare AI Gateway between the proxy and
Gemini, Upstash Redis for runtime state, and no database and no user accounts
(Stripe is the customer source of truth; the desktop app holds tokens in the
OS keychain).

## Free-tier discipline (read this first)

Nothing in the free web demo or the BYOK path touches these endpoints or
requires their env. The studio, `/api/copilotkit`, the vote flow, and the
desktop BYOK providers are untouched; every hosted/billing endpoint answers
503 when its env is absent and spends nothing without a valid Capturia JWT.
Adding a dependency from any free path onto `/api/hosted` or `/api/billing`
is a regression. Hosted audience voting (the `/api/vote` rooms the packaged
app publishes to on www.capturia.dev, issue #52) currently ships free with
no entitlement check; gating it under Pro is a future decision.

## Request path

```
Desktop app (Capturia JWT from keychain)
  -> POST /api/hosted/...            Vercel function, this repo
       1. verify Ed25519 JWT          stateless, lib/hosted/jwt.ts
       2. Redis brakes                 lib/hosted/gate.ts
            kill switch                hosted:kill
            entitlement cache          hosted:ent:<customer>
            rate limit                 ~10/min sliding window
            monthly token budget       hosted:usage:<customer>:<YYYY-MM>
            flash sub-budget           hosted:usage-flash:<customer>:<YYYY-MM>
                                       (gemini-2.5-flash only, checked after
                                       the body names the model; deck codegen
                                       stops while lite traffic continues)
            per-lane lease             hosted:lease:<customer>:<stream|batch>
                                       (live overlay stream and deck codegen
                                       never 409 each other)
       3. forward Gemini wire body
            CAPTURIA_AI_GATEWAY_URL    Cloudflare AI Gateway (per-user $ caps,
                                       Gemini key in gateway secret store)
            else                       direct Gemini with server GOOGLE_API_KEY
       4. stream SSE back; on end: release lease, record one usage event to
          Redis and (when configured) Stripe Billing Meters. A client abort
          before Gemini's usageMetadata frame is charged the request-size
          estimate (~4 chars/token), so bailing early cannot dodge the
          budget; upstream failures release the lease and charge nothing.
          Settlement is parked on next/server's after() so a serverless
          suspend cannot lose it.
```

Entitlement flow (no accounts):

```
Stripe Checkout (test mode)
  -> webhook /api/billing/webhook (signature-verified)
       checkout.session.completed  -> entitlement active in Redis
                                      + one-time activation code
       subscription.updated        -> entitlement cache follows status
       subscription.deleted        -> entitlement revoked
  -> POST /api/billing/activate { code, deviceId }
       one-time code -> long-lived refresh token (device cap: 3)
  -> POST /api/billing/token { refreshToken }
       -> Ed25519 JWT (~1h) held in the keychain "capturia-hosted" slot
  -> POST /api/billing/deactivate (device JWT)
       frees the calling device's seat; its refresh token stops minting
       on the next /api/billing/token check
```

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/hosted/v1/generate` | Stable alias: `{ model?, stream?, request }` where `request` is a Gemini `generateContent` payload; streams SSE back |
| `POST /api/hosted/v1beta/models/<id>:streamGenerateContent` | The exact wire shape `@ai-sdk/google` emits; lets the desktop runtime point at the proxy by swapping `baseURL` + key slot only |
| `POST /api/hosted/v1beta/models/<id>:generateContent` | Non-streaming variant |
| `GET /api/hosted/usage` | Current-period usage for the authenticated customer (same JWT check as the proxy): `{ tokensUsed, monthlyTokenBudget, flashTokensUsed, flashTokenBudget, periodEnd }`. Feeds the in-app hours meter |
| `POST /api/billing/checkout` | Creates the Stripe Checkout session (subscription, `STRIPE_PRICE_ID`) |
| `POST /api/billing/webhook` | Stripe events -> Redis entitlement cache + activation codes (deduplicated on event.id, ordered by event.created with revocations winning same-second ties, one code per checkout session; dedup markers commit only after effects land, so a mid-apply fault answers 500 and the Stripe retry re-processes instead of being swallowed) |
| `POST /api/billing/activate` | `{ code, deviceId }` -> `{ refreshToken, token, expiresAt, devices }` |
| `POST /api/billing/token` | `{ refreshToken }` -> `{ token, expiresAt }` |
| `POST /api/billing/deactivate` | Frees the calling device's seat (same device-JWT auth as the proxy; the JWT names customer AND device, so a caller can only ever free its own slot). Idempotent; answers `{ ok, devices }`. The device's refresh token stops minting on its next refresh |
| `POST /api/billing/portal` | Creates a Stripe Billing Portal session (card, invoices, cancel) for the authenticated customer and answers only its URL. Device-JWT auth; the JWT `sub` IS the Stripe customer id, so no lookup exists to drift. Rate-braked at 5/min per customer before the outbound Stripe write, mirroring checkout's per-IP cap |
| `GET /api/billing/activation-code?session_id=cs_...&pickup=...` | One-time code pickup for the checkout success page; the pickup nonce is minted per checkout, travels only in the success URL, and the code is filed under hash(session, nonce), so a bare session id retrieves nothing |

The JWT rides in `x-goog-api-key` (what `@ai-sdk/google` sends) or a
standard `Authorization: Bearer`. The proxy enforces a server-side model
allowlist (`gemini-2.5-flash-lite`, `gemini-2.5-flash` by default), so a
valid token cannot pick an expensive model on Capturia's key. Requests are
text-only: `fileData`/`inlineData` parts are refused with 400 (their token
cost is decoupled from request size, which would defeat the budget brakes),
and `generationConfig.maxOutputTokens` is clamped server-side.

## Upgrade UX (M11 slice 2)

The guided flow, end to end: the Settings Capturia Pro row shows "Upgrade to
Pro" (desktop builds with the billing bridge); main POSTs /api/billing/checkout
and opens the Stripe page in the OS browser; Stripe redirects the paid session
to /?checkout=success&session_id=...&pickup=..., where the landing overlay
(components/landing/CheckoutSuccess.tsx) collects the one-time code from
/api/billing/activation-code, tolerating webhook lag; the buyer pastes the
code back into Settings, main trades it via /api/billing/activate for a
refresh token + first JWT (both in the OS-keychain vault, the refresh token
in the renderer-invisible capturia-hosted-refresh slot), and
electron/hosted-billing.js keeps the JWT fresh from then on (80% of lifetime,
clamped; 401/403 drop credentials, 402 retries hourly, transient errors every
5 minutes). Clearing the Pro row in Settings clears BOTH slots and the timer.
Decision logic lives in lib/hosted-billing.ts and lib/checkout-success.ts,
fully unit-tested; Electron consumes the gen build.

An active Pro row also manages itself (issues #10/#48): "Manage
subscription" asks /api/billing/portal for a Stripe customer portal URL and
opens it in the OS browser (https-only, same rule as checkout URLs), so
card updates, invoices, and cancellation all live on Stripe's page.
"Deactivate this device" (with a confirm step) frees this Mac's seat via
/api/billing/deactivate, then clears the local credentials through the
same vault-clear routing as the Clear button, dropping the app back to
BYOK; the freed seat lets a new Mac activate, which is also what the
4th-device refusal message now points at.

## Env contract

| Variable | Where | Meaning |
|---|---|---|
| `STRIPE_SECRET_KEY` | server | Stripe API key (sk_test until launch). Absent: billing endpoints 503, proxy skips meter events |
| `STRIPE_WEBHOOK_SECRET` | server | Webhook signature secret (whsec_...) |
| `STRIPE_PRICE_ID` | server | Pro monthly price, printed by `scripts/hosted-setup-stripe.mjs` |
| `STRIPE_API_BASE` | dev only | Point at stripe-mock (`http://localhost:12111`) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | server | Runtime state. Absent: in-memory single-process fallback in dev; PRODUCTION REFUSES to boot the hosted/billing endpoints without it (503, Stripe keeps retrying) so paid activations can never be acked into a store that forgets them |
| `CAPTURIA_AI_GATEWAY_URL` | server | Cloudflare AI Gateway base (`https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/google-ai-studio`). Absent: direct Gemini fallback |
| `CAPTURIA_AI_GATEWAY_TOKEN` | server | Optional `cf-aig-authorization` token for an authenticated gateway |
| `GOOGLE_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`) | server | Gemini key for the direct fallback; with gateway-side BYOK neither is needed here |
| `CAPTURIA_JWT_PRIVATE_KEY` | server | base64 PKCS8 DER Ed25519 (PEM also accepted). Mints JWTs. NEVER commit |
| `CAPTURIA_JWT_PUBLIC_KEY` | server | base64 SPKI DER. Verifies JWTs at the proxy |
| `CAPTURIA_HOSTED_MODELS` | server | Optional csv override of the model allowlist |
| `CAPTURIA_HOSTED_RATE_LIMIT` / `_MONTHLY_TOKENS` / `_LEASE_TTL_MS` | server | Brake tuning (defaults 10/min, 5.5M tokens = 20 presentation hours at 275k/hour, 120s) |
| `CAPTURIA_HOSTED_FLASH_MONTHLY_TOKENS` | server | Monthly `gemini-2.5-flash` sub-budget within the overall allowance (default 500k; deck codegen is the flash consumer). Exhaustion answers 429 with a distinct marker-tagged body in the Gemini error shape, which the desktop app renders as the calm deck-allowance state; lite-tier calls continue |
| `CAPTURIA_HOSTED_MAX_OUTPUT_TOKENS` | server | Per-request output clamp injected into every forwarded generationConfig (default 8192) |
| `CAPTURIA_HOSTED_DEV_ENTITLEMENT` | dev only | Seeds an active entitlement + the fixed dev activation code for that customer id. Seeded only into the in-memory backend: ignored in production builds AND whenever real Upstash env is present |
| `CAPTURIA_HOSTED_URL` | desktop | Proxy origin override for the desktop runtime (dev: `http://localhost:3000/api/hosted`) |
| `CAPTURIA_HOSTED_MODEL` | desktop | Hosted model id override (must be on the server allowlist) |

Generate the keypair with `node scripts/hosted-gen-keys.mjs` (prints both
env lines; nothing touches disk).

## Desktop wiring (slice 1 scope)

The keychain vault gained a `capturia-hosted` slot (Settings shows it as
"Capturia Pro"). When it holds a token, `resolveDesktopAgentSpec`
(lib/desktop-runtime.ts) returns a `hosted` route and the loopback runtime
builds its Gemini client with `baseURL` pointed at the proxy and the token
in the key slot; deck codegen does the same. Slice 1 stores the JWT
directly; the refresh loop, device management UX, and guided upgrade land
with the desktop entitlement slice. Everything is testable today via
`CAPTURIA_HOSTED_URL`.

## Local dev quickstart (no paid services)

```sh
node scripts/hosted-gen-keys.mjs        # append both lines to .env.local
echo "CAPTURIA_HOSTED_DEV_ENTITLEMENT=cus_dev" >> .env.local
# plus a Google key for the direct fallback (GOOGLE_API_KEY or
# GOOGLE_GENERATIVE_AI_API_KEY)
npm run dev

TOKEN=$(node --env-file=.env.local scripts/hosted-dev-token.mjs cus_dev)
curl -N -X POST http://localhost:3000/api/hosted/v1/generate \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"request":{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}}'
```

The activation flow is drivable the same way: the dev seed plants the code
`CAPTURIA-DEV0-DEV0-DEV0-DEV0`, so `POST /api/billing/activate` with it (plus
any `deviceId` of 6+ chars) returns a refresh token, and
`POST /api/billing/token` mints JWTs from then on. Note the in-memory
fallback lives inside the dev server process: seeding and reading happen
through the endpoints, not from other processes.

## Verification runbook

Ran green for this slice (2026-07): `npm test` (vitest, includes the JWT,
gate, entitlement, Stripe-client, proxy-planning, memory-redis, backend, and
desktop-runtime suites), `tsc --noEmit`, `next build`, eslint (pre-existing
React 19 baseline only), `npm run smoke:runtime`, `npx playwright test`
(BYOK studio untouched, live agent turn included), plus the live local
end-to-end above: streamed and non-streamed generations through the proxy
with a real Gemini key, 401 (missing/garbage token), 403 (model allowlist),
404 activation-code replay, 401 bad refresh token, 409 concurrent stream,
and 429 with `retry-after` after the 10/min window filled.

When the Stripe sk_test key lands:

1. `STRIPE_SECRET_KEY=sk_test_... node scripts/hosted-setup-stripe.mjs`,
   put the printed `STRIPE_PRICE_ID` in the env.
2. `stripe listen --forward-to localhost:3000/api/billing/webhook`
   (Stripe CLI), put the printed `whsec_...` in `STRIPE_WEBHOOK_SECRET`.
3. Drive a test checkout: `curl -X POST .../api/billing/checkout`, open the
   returned URL, pay with `4242 4242 4242 4242`, watch the webhook log
   `activation_minted`, land on the success URL and fetch the code via
   `/api/billing/activation-code?session_id=...&pickup=...` (both come from
   the success redirect), then run the activate -> token -> generate chain
   above with the real code.
4. Cancel the subscription in the test dashboard and confirm the next
   `/api/billing/token` call answers 402 and the proxy rejects new calls.
5. Confirm meter events in the dashboard (Billing -> Meters ->
   capturia_hosted_tokens) after a generation.
6. Optional offline check: `stripe-mock` + `STRIPE_API_BASE=http://localhost:12111`
   exercises the setup script and checkout endpoint without the network.

When the Cloudflare account lands:

1. Create an AI Gateway, store the Gemini key in its BYOK secret store, set
   per-user dollar spend limits.
2. Set `CAPTURIA_AI_GATEWAY_URL` (and `CAPTURIA_AI_GATEWAY_TOKEN` if the
   gateway is authenticated); remove the server-side Google key.
3. Re-run the streamed curl above and confirm the request appears in the
   gateway logs.

When the dedicated GCP project lands: new key into the gateway secret
store, arm the monthly spend cap and lowered RPD quota per issue #10, then
re-run the same curl.

## Security notes

- JWTs are Ed25519 only; the verifier pins `alg: EdDSA`, so `alg:none` and
  HMAC downgrades are rejected structurally (unit-tested).
- Refresh tokens are stored only as SHA-256 hashes; activation codes are
  one-time (GETDEL) and 80-bit random; codes and tokens are never logged.
- Client headers never travel upstream; the proxy builds fresh headers per
  call, so the JWT cannot leak to Google or Cloudflare.
- Kill switch: `SET hosted:kill 1` in Redis stops all hosted generation
  (503) without a deploy; `DEL hosted:kill` restores it.
- Budget/rate races between serverless invocations are tolerated by design:
  the gateway dollar caps and the GCP project cap sit behind them
  (defense in depth per issue #10).
