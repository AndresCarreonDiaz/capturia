# Telemetry and analytics

Capturia's promise is that what you say and show stays on your Mac: speech is
transcribed on-device and no meeting content ever touches a Capturia server.
Product measurement has to live inside that promise, so it is split into two
deliberately tiny channels: cookieless web analytics on the hosted pages, and
a four-field anonymous beacon in the desktop app.

## What the desktop app sends

When telemetry is on (the default), the app POSTs this exact JSON to
`https://www.capturia.dev/api/beacon`, and nothing else, ever:

```json
{
  "installId": "9b2f8c1e-4a3d-4f6b-8a1c-2d3e4f5a6b7c",
  "event": "launch",
  "appVersion": "0.1.0",
  "macosVersion": "26.0"
}
```

- `installId`: a random UUID stored in
  `~/Library/Application Support/Capturia/settings.json`, minted at the first
  send that consent allows (an opted-out install never gets one). It
  identifies an installation so unique installs can be counted; it is
  connected to nothing else (no account, no email, no hardware id).
- `event`: `launch` (once per app start), `camera-installed` (once per
  install, when the camera extension activation lands), or `update-check`
  (reserved for the future updater; the app does not send it yet).
- `appVersion`: the Capturia version (semver, `x.y.z` with an optional short
  prerelease suffix; the server rejects anything else), for
  adoption-per-release counts.
- `macosVersion`: the macOS version (two or three numeric components), for
  support decisions.

What is NEVER sent, by construction: audio, transcripts, overlay or deck
content, prompts, API keys, file names, IP-derived location, or any free-form
text. The server rejects any payload with extra fields (`lib/beacon.ts`
validates against an allowlist), so the wire contract cannot silently grow.

Delivery is fire-and-forget: one attempt per event per run with a 3 second
timeout, and any failure is swallowed silently with no retry. Offline use is
fully supported and generates nothing.

## Consent comes first

On the very first run nothing is sent and no installId exists yet: the launch
ping waits until the onboarding welcome card, which carries the disclosure
sentence and the toggle, is actually behind the user (advanced, finished, or
skipped, in all cases with the toggle state known). If the toggle was
unchecked, the parked ping is dropped silently and nothing was ever sent from
that install. Every later run has an explicit recorded choice and sends (or
stays silent) immediately on launch. Quitting the app while the welcome card
is still up sends nothing; the same gate simply applies again next run.

Development builds are silent by default: an unpackaged shell (`npm run
electron` / `electron-dev`) never sends unless `CAPTURIA_BEACON_URL` is
explicitly set, so dev launches of this public repo can never count as
production installs.

## Turning it off

Any of these disables the beacon entirely:

- The toggle in the onboarding card's first step.
- Settings (Cmd+,) under Privacy.
- Hand-editing `settings.json` in the app's user data directory:
  `{ "telemetry": false }`.

## What is stored server-side

Aggregates only, in Redis (Upstash), with no per-user records:

| Key | Contents | TTL |
| --- | --- | --- |
| `beacon:ids:d:<YYYYMMDD>` | HyperLogLog of installIds seen that UTC day | 40 days |
| `beacon:ids:m:<YYYYMM>` | HyperLogLog of installIds seen that UTC month | 400 days |
| `beacon:activated` | HyperLogLog of installIds that ever installed the camera | none |
| `beacon:count:<event>` | plain counter per event | none |
| `beacon:versions` | hash of appVersion to launch count (capped at 200 fields) | 800 days |
| `beacon:versions-overflow` | launches whose NEW version was refused by the field cap | 800 days |
| `beacon:rl:<hash>` | per-IP rate limit counter; the only IP-derived value, a truncated SHA-256, gone when the window expires | 60 s |

HyperLogLogs can only answer "how many", never "who": individual installIds
are not recoverable from storage. Raw IPs are never stored at all.

The versions hash is defended in depth against poisoning (someone POSTing
forged-but-valid payloads with made-up versions): only real semver shapes
pass validation, known versions always keep counting, NEW versions past the
200-field cap land on the `versionsOverflow` counter in the summary instead
of vanishing silently, and the whole hash ages out on its TTL. If overflow
ever reads non-zero, inspect the hash and delete the junk fields manually:
`HDEL beacon:versions <junk-version> ...` (real release fields can be
re-added by the next genuine launch, so over-deleting is harmless).

Cost math for the Upstash free tier (500k commands/month): a beacon write is
one pipeline of 6 commands, so 1,000 DAU averaging one launch per day is
about 186k commands/month, and the limiter adds one command per request.
Comfortable at launch scale; at roughly 2,500 DAU move to the pay-as-you-go
tier (still dollars per month). Without Upstash env vars the store falls back
to in-memory (fine for dev; a serverless deploy without Upstash will count
per-instance and forget on cold start, the same documented limitation as the
vote store).

## Reading the numbers

Owner-only summary endpoint, guarded by `CAPTURIA_METRICS_TOKEN` (with the
env var unset the endpoint answers 503 and exposes nothing):

```sh
curl -H "Authorization: Bearer $CAPTURIA_METRICS_TOKEN" \
  https://www.capturia.dev/api/beacon/summary
```

```json
{
  "backend": "redis",
  "day": "20260710",
  "month": "202607",
  "dau": 42,
  "wau": 180,
  "mau": 512,
  "activations": 210,
  "events": { "launch": 3120, "camera-installed": 214, "update-check": 0 },
  "versions": { "0.1.0": 3120 },
  "versionsOverflow": 0
}
```

`activations` is unique installs that ever completed the camera install, so
activation rate is `activations / mau` (or against total installs once
downloads exist). The funnel reads: Vercel Analytics pageviews, then the
`download_click` custom event, then beacon `launch` uniques, then
`activations`.

## Web analytics (hosted pages only)

The landing, the `/studio` browser demo, and the `/vote` phone pages mount
Vercel Web Analytics from the root layout: cookieless, no cross-site
tracking, page views plus one custom event (`download_click`, fired by
`components/landing/DownloadLink.tsx` with a `location` property naming the
CTA). The Electron build ships none of it: `next.config.ts` aliases
`@vercel/analytics` to a no-op stub for the static export, and
`scripts/build-electron-export.mjs` can prove it with
`grep -r "vercel-scripts\|_vercel/insights" out/` coming back empty.

## Operator setup

- Vercel: enable Web Analytics on the project (dashboard toggle; already
  done for www.capturia.dev). Pageviews and `download_click` appear under
  Analytics after the next deploy.
- Vercel env: set `CAPTURIA_METRICS_TOKEN` to a long random secret (this
  also arms `/api/beacon/summary`). The Upstash integration provides
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or the KV flavor),
  shared with the vote store; the beacon uses the same database.
- Desktop dev: point the app at a local endpoint with
  `CAPTURIA_BEACON_URL=http://localhost:3000/api/beacon npm run electron-dev`
  and read it back from `http://localhost:3000/api/beacon/summary` (set
  `CAPTURIA_METRICS_TOKEN` for the dev server first).
