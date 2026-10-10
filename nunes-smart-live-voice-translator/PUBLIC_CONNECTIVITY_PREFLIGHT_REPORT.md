# NUNES SMART LIVE VOICE TRANSLATOR — PUBLIC CONNECTIVITY & PLIVO READINESS REPORT

## Document Control
- **Execution Date**: 2026-10-10
- **Environment**: Staging / Local Hybrid
- **Git Branch**: `feature/realtime-stt-language-router`
- **Latest Commit**: `c73a1a403bb9e319868d0074d8794fdd805b087a` (feat: add independent Plivo call-leg foundation)
- **Safety Gate Status**: **STRICTLY LOCKED**
  - `actualAudioIsolationVerified`: **`false`**
  - `productionTranslationAuthorized`: **`false`**
  - `livePlayback`: **`BLOCKED`**
  - `originalBypass`: **`BLOCKED`**
  - `emergencyStopEngaged`: **`false`** (Operational & verified)

---

## 1. PUBLIC_BASE_URL & Public Connectivity Status

### 1.1 Configuration Inspection
- **Configured Public Host**: `remote-material-staple.ngrok-free.dev`
- **Origin**: `https://remote-material-staple.ngrok-free.dev`
- **Protocol**: HTTPS (Port 443)

### 1.2 TLS & Public Network Probing
A live TLS handshake probe was conducted against the configured public endpoint:
- **TLS Handshake**: **SUCCESS** (`TLSv1.3`, port 443)
- **Certificate Authority**: Let's Encrypt (`CN: *.ngrok-free.dev`, `Issuer: Let's Encrypt`)
- **Validity Window**: Sep 25, 2026 to Dec 24, 2026 (**Valid**)
- **Public Tunnel Status**: **NOT VERIFIED / OFFLINE (`ERR_NGROK_3200`)**
  - When issuing HTTPS requests to `https://remote-material-staple.ngrok-free.dev/`, ngrok returns:
    ```
    HTTP/1.1 404 Not Found
    ngrok-error-code: ERR_NGROK_3200
    The endpoint remote-material-staple.ngrok-free.dev is offline.
    ```
  - **Reason**: The ngrok tunnel agent forwarding traffic to the local machine or staging container is currently stopped / not running.

---

## 2. Plivo Webhook & WebSocket Endpoint Specifications

From inspecting the active code in [`independentCallLegUrls.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallLegUrls.ts) and [`independentCallLegXml.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallLegXml.ts), the exact URLs generated for Plivo callbacks and WebSocket media streams are:

| Purpose | Protocol & Method | Exact URL Pattern |
|---|---|---|
| **Answer Callback** | `HTTPS POST` | `https://remote-material-staple.ngrok-free.dev/plivo/independent/answered?sessionId={sessionId}&role={customer\|staff}` |
| **Hangup / Completed** | `HTTPS POST` | `https://remote-material-staple.ngrok-free.dev/plivo/independent/completed?sessionId={sessionId}&role={customer\|staff}` |
| **Stream Status** | `HTTPS POST` | `https://remote-material-staple.ngrok-free.dev/plivo/independent/stream-status?sessionId={sessionId}&role={customer\|staff}` |
| **Stream Started** | `HTTPS POST` | `https://remote-material-staple.ngrok-free.dev/plivo/independent/stream-started?sessionId={sessionId}&role={customer\|staff}` |
| **Stream Stopped** | `HTTPS POST` | `https://remote-material-staple.ngrok-free.dev/plivo/independent/stream-stopped?sessionId={sessionId}&role={customer\|staff}` |
| **Media Stream WebSocket** | `WSS Upgrade` | `wss://remote-material-staple.ngrok-free.dev/plivo/independent/stream?sessionId={sessionId}&role={customer\|staff}&connectionToken={token}` |

### Plivo XML `<Stream>` Declaration
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000" statusCallbackUrl="https://remote-material-staple.ngrok-free.dev/plivo/independent/stream-status?sessionId={sessionId}&amp;role={role}" statusCallbackMethod="POST">
    wss://remote-material-staple.ngrok-free.dev/plivo/independent/stream?sessionId={sessionId}&amp;role={role}&amp;connectionToken={token}
  </Stream>
  <Hangup/>
</Response>
```

---

## 3. Plivo V3 Webhook Signature Validation & Nonce Handling

In [`plivoWebhookRequestGuard.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/plivoWebhookRequestGuard.ts) and [`signedIndependentCallCallbacks.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/signedIndependentCallCallbacks.ts):
- Every inbound Plivo callback requires valid `X-Plivo-Signature-V3` and `X-Plivo-Signature-V3-Nonce` headers calculated using HMAC-SHA256 over the canonical URL, query string, and POST parameters with `PLIVO_AUTH_TOKEN`.
- **Replay Protection**: The [`IndependentCallbackReplay`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallbackReplay.ts) mechanism tracks nonces per session, prevents duplicate callback processing, and caches idempotent responses.
- **WebSocket Upgrade Authentication**: In [`independentCallFeature.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallFeature.ts) (lines 73–91), every incoming WebSocket upgrade to `/plivo/independent/stream` requires:
  1. Header `Upgrade: websocket`.
  2. Query parameters `connectionToken`, `role`, and `sessionId`.
  3. A fresh, valid Plivo V3 signature over the upgrade URL.
  4. Matching cryptographic connection token issued during call XML construction.
  - Unauthorized or unowned upgrade requests receive HTTP 403 or WebSocket closure code 1008.

---

## 4. Environment Variables & Runtime Readiness

All variables in root `.env` were verified safely:

| Variable | Configured | Detail |
|---|---|---|
| `DATABASE_URL` | **YES** | 149 chars, Neon PostgreSQL connection string |
| `PLIVO_AUTH_ID` | **YES** | 20 chars, Plivo account ID |
| `PLIVO_AUTH_TOKEN` | **YES** | 40 chars, Plivo secret auth token |
| `PLIVO_NUMBER` | **YES** | 16 chars, Indian international format caller ID |
| `SARVAM_API_KEY` | **YES** | 36 chars, Sarvam AI authentication token |
| `PORT` | **YES** | 4 chars (`8787`) |
| `STAFF_PHONE_NUMBER` | **YES** | 13 chars, Indian international format phone number |
| `PUBLIC_BASE_URL` | **YES** | 45 chars (`https://remote-material-staple.ngrok-free.dev`) |
| `NUNES_ADMIN_PASSWORD` | **YES** | 64 chars, Management API admin secret |
| `NUNES_INDEPENDENT_CALLS_ENABLED` | **NOT SET** (in file) | Needs `true` to register `/plivo/independent/*` endpoints |
| `NUNES_MANAGEMENT_ENABLED` | **NOT SET** (in file) | Defaults to enabled in test mode |

---

## 5. Live Local Server & Emergency Stop Verification

- **Realtime Server Process**: Active and listening on `0.0.0.0:8787` (PID 15324).
- **Health Check (`GET /health`)**:
  ```json
  {"service":"realtime-server","status":"HEALTHY","database":"CONNECTED"}
  ```
- **Management Status (`GET /management/pilot/status`)**:
  - `pilotReady: true`
  - `emergencyStopEngaged: false`
  - `allowlistConfigured: true` (Customer: `+********8000`, Staff: `+********7000`)
- **Emergency STOP Live Probe**:
  1. Triggered `POST /management/pilot/emergency-stop` → Returned `200 OK`, `emergencyStopEngaged: true`.
  2. Checked `/management/pilot/status` → Returned `pilotReady: false`, `emergencyStopEngaged: true`.
  3. Triggered `POST /management/pilot/reset-emergency-stop` → Returned `200 OK`, `emergencyStopEngaged: false`.
  4. Verified restoration → `pilotReady: true`, `emergencyStopEngaged: false`.
  - **Result: Emergency STOP is fully operational on the running server.**

---

## 6. Dashboard & Realtime Server Communication

In [`apps/dashboard/lib/serverEnvironment.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/dashboard/lib/serverEnvironment.ts):
- The Next.js dashboard reads `NUNES_MANAGEMENT_API_URL` (defaulting to `http://127.0.0.1:8787`).
- The proxy handler at [`apps/dashboard/app/api/management/[...path]/route.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/dashboard/app/api/management/%5B...path%5D/route.ts) signs and proxies requests with `NUNES_ADMIN_PASSWORD` to `http://127.0.0.1:8787/management/*`.
- Both applications share the same root environment file and communicate locally over loopback HTTP.

---

## 7. Deployment Blockers & Current Connectivity Summary

| Area | Status | Finding |
|---|---|---|
| **Local Realtime Server** | **READY** | Fastify running on port 8787, DB CONNECTED, admin auth working, 405 offline tests passing |
| **Public HTTPS DNS & TLS** | **PASS** | TLS 1.3 handshake succeeds, Let's Encrypt certificate valid through Dec 24, 2026 |
| **Public HTTPS / WSS Reachability** | **NOT VERIFIED / BLOCKED** | ngrok tunnel is offline (`ERR_NGROK_3200`). Plivo webhooks and WebSocket streams cannot reach the server from the public internet |
| **Independent Call Flag** | **BLOCKED** | `NUNES_INDEPENDENT_CALLS_ENABLED` is not set in `.env` |
| **Persistent WebSocket Support** | **READY (Local)** / **BLOCKED (Public)** | Fastify `@fastify/websocket` is enabled, but public tunnel is not routing |
| **Audio Isolation Gate** | **STRICTLY LOCKED** | `actualAudioIsolationVerified = false`, `livePlayback = BLOCKED` |

---

## 8. Next Safe Verification Steps Before Real Calls

1. **Start Public Tunnel (ngrok)**:
   - Run the ngrok agent locally mapping port 8787:
     ```powershell
     ngrok http 8787 --url=https://remote-material-staple.ngrok-free.dev
     ```
   - Verify that `https://remote-material-staple.ngrok-free.dev/health` returns `200 OK`.
2. **Enable Independent Calls Flag**:
   - Add `NUNES_INDEPENDENT_CALLS_ENABLED=true` to `.env` (or pass to process environment).
   - Ensure `NUNES_INDEPENDENT_CALLS_TEST_MODE=true` for safe dry-run mode before actual outbound calls.
3. **Verify Public Webhook Signature Handshake**:
   - Issue a test signed POST callback through the public ngrok URL to verify round-trip signature validation over the public network.
4. **Controlled Operator Live Authorization**:
   - Only after public WSS connectivity is confirmed should the operator proceed with the two allowlisted phone numbers.

