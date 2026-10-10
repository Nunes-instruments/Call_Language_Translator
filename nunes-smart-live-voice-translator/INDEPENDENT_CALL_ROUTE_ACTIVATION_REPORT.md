# NUNES SMART LIVE VOICE TRANSLATOR — INDEPENDENT CALL ROUTE ACTIVATION REPORT

## Document Control
- **Execution Date**: 2026-10-10
- **Environment**: Staging / Local Hybrid with Active ngrok Tunnel
- **Public Origin**: `https://remote-material-staple.ngrok-free.dev`
- **Git Branch**: `feature/realtime-stt-language-router`
- **Test Results**: **405 passing offline tests across 42 test files** (0 failures)
- **TypeScript**: **0 errors across all 5 project workspaces**

---

## 1. Safety Gate Verification & Source Inspection

Before activating route registration, the source code was inspected to confirm that setting `NUNES_INDEPENDENT_CALLS_ENABLED=true`:
1. **Does NOT automatically initiate calls**:
   - Outbound call creation requires an explicit authenticated API request (`POST /internal/independent-calls` or pilot session start).
   - In [`independentPlivoCallCreator.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentPlivoCallCreator.ts), the hard gate `INDEPENDENT_LIVE_CALLS_APPROVED = false as const` is compiled in. Any live Plivo call invocation unconditionally throws `LIVE_CALL_APPROVAL_REQUIRED`.
2. **Does NOT permit live audio playback**:
   - `IndependentTranslationPipeline.productionPlayback()` unconditionally throws `AUDIO_ISOLATION_UNVERIFIED`.
   - `TwoLegAudioCoordinator.setTranslationEnabled()` unconditionally throws `"Translation activation blocked until audio isolation is verified"`.
3. **Does NOT permit original audio bypass**:
   - When identical languages are detected (Tamil-to-Tamil), the pipeline halts and sets `lastError = ORIGINAL_AUDIO_PATH_UNVERIFIED`. No bridging `<Dial>` element exists in independent leg XML.
4. **Enforces Webhook Authentication & Token Security**:
   - In [`plivoWebhookRequestGuard.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/plivoWebhookRequestGuard.ts), every inbound Plivo callback requires valid `X-Plivo-Signature-V3` and `X-Plivo-Signature-V3-Nonce` headers calculated using HMAC-SHA256 with `PLIVO_AUTH_TOKEN`.
   - WebSocket upgrades require a valid Plivo signature plus a matching 32-byte cryptographically random `connectionToken` issued during call creation.

---

## 2. Configuration & Safe Process Restart

1. **Root `.env` Update**:
   - `NUNES_INDEPENDENT_CALLS_ENABLED=true` was added to `.env` without modifying or exposing other variables.
   - Normalized formatting spaces in `PLIVO_NUMBER` to ensure strict international E.164 compliance (`/^\+?[1-9]\d{6,14}$/`).
2. **Targeted Process Restart**:
   - Located the running realtime server process on port 8787 (PID 15324).
   - Terminated only PID 15324 without affecting any unrelated Node.js processes.
   - Launched the new realtime-server process.

---

## 3. Post-Restart Connectivity & Endpoint Probes

### 3.1 Health Endpoints
- **Local Health** (`http://127.0.0.1:8787/health`):
  ```json
  {"service":"realtime-server","status":"HEALTHY","database":"CONNECTED"}
  ```
  **HTTP 200 OK**
- **Public Health** (`https://remote-material-staple.ngrok-free.dev/health`):
  ```json
  {"service":"realtime-server","status":"HEALTHY","database":"CONNECTED"}
  ```
  **HTTP 200 OK via ngrok**

### 3.2 Independent Route Security Probes (Public & Unauthenticated)
All newly activated routes were probed without valid signatures or credentials to verify fail-closed behavior:
- `POST /plivo/independent/answered` (unauthenticated) → **HTTP 403 Forbidden**
- `POST /plivo/independent/stream-status` (unauthenticated) → **HTTP 403 Forbidden**
- `POST /plivo/independent/completed` (unauthenticated) → **HTTP 403 Forbidden**
- `POST /internal/independent-calls` (unauthenticated) → **HTTP 401 Unauthorized**

### 3.3 Pilot Status & Allowlist Verification
- **Pilot Status Endpoint** (`GET /management/pilot/status`):
  ```json
  {
    "pilotReady": true,
    "emergencyStopEngaged": false,
    "emergencyStopReason": null,
    "totalSessionsCreated": 0,
    "maxSessionsAllowed": 5,
    "cumulativeEstimatedCostUsd": 0,
    "maxBudgetUsd": 2,
    "maxDurationSeconds": 180,
    "activeSessionsCount": 0,
    "allowlistConfigured": true,
    "allowlistMasked": {
      "customer": "+********8556",
      "staff": "+********3212"
    },
    "gates": {
      "actualAudioIsolationVerified": false,
      "productionTranslationAuthorized": false,
      "livePlayback": "BLOCKED",
      "originalBypass": "BLOCKED"
    }
  }
  ```
  All safety gates remain locked (`BLOCKED`).

---

## 4. Test Suite & TypeScript Results
- **TypeScript**: `npm.cmd run typecheck --workspaces --if-present` → **PASS** (0 errors).
- **Test Suite**: `npm.cmd test --workspaces --if-present` → **PASS** (405 passed across 42 test files).

---

## 5. Rollback Procedure

If route registration must be reverted:
1. Edit root `.env` and remove or set `NUNES_INDEPENDENT_CALLS_ENABLED=false`.
2. Locate the realtime server process:
   ```powershell
   Get-NetTCPConnection -LocalPort 8787 | Select-Object LocalPort, OwningProcess
   ```
3. Stop the process:
   ```powershell
   Stop-Process -Id <PID> -Force
   ```
4. Restart the server:
   ```powershell
   npm.cmd --workspace apps/realtime-server run start
   ```
5. Confirm `/health` returns 200 and `/plivo/independent/answered` returns 404.

