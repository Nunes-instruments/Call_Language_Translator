# NUNES SMART LIVE VOICE TRANSLATOR — PERMANENT PILOT ALLOWLIST CORRECTION REPORT

## Document Control
- **Execution Date**: 2026-10-10
- **Environment**: Staging / Local Hybrid with Active ngrok Tunnel
- **Public Origin**: `https://remote-material-staple.ngrok-free.dev`
- **Git Branch**: `feature/realtime-stt-language-router`
- **TypeScript**: **0 errors across all 5 project workspaces**
- **Offline Tests**: **406 passed across 42 test files** (0 failures)

---

## 1. Action Summary & Environment Modification

### 1.1 Secure Backup
Before modifying the configuration, a timestamped secure backup of root `.env` was created without displaying its contents:
- `.env.backup.<timestamp>`

### 1.2 Permanent Allowlist Variables Configured
The exact operator-confirmed phone numbers were added to root `.env` without duplicate definitions:
```bash
NUNES_PILOT_CUSTOMER_NUMBER=+919087768000
NUNES_PILOT_STAFF_PHONE_NUMBER=+919159267000
```
- **Preserved Variables**: All existing credentials (`DATABASE_URL`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_NUMBER`, `SARVAM_API_KEY`, `NUNES_ADMIN_PASSWORD`, etc.) were preserved intact.
- **`STAFF_PHONE_NUMBER` Preserved**: Kept untouched (ending in `8556`).
- **Git Status**: Confirmed `.env` and `.env.backup.*` remain excluded from Git tracking.

---

## 2. Server Restarts & Persistence Verification

### 2.1 Targeted Process Restarts
- Terminated only the running realtime server process on port 8787 without affecting unrelated processes.
- Started the server via `npm run start`.

### 2.2 Endpoint Connectivity Probes
- **Local Health** (`http://127.0.0.1:8787/health`): **HTTP 200 OK** (`service: realtime-server`, `status: HEALTHY`, `database: CONNECTED`).
- **Public Health** (`https://remote-material-staple.ngrok-free.dev/health`): **HTTP 200 OK via ngrok**.

### 2.3 Authenticated Pilot Status Verification
Queried `https://remote-material-staple.ngrok-free.dev/management/pilot/status` with admin bearer authorization:
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
    "customer": "+********8000",
    "staff": "+********7000"
  },
  "gates": {
    "actualAudioIsolationVerified": false,
    "productionTranslationAuthorized": false,
    "livePlayback": "BLOCKED",
    "originalBypass": "BLOCKED"
  }
}
```

### 2.4 Controlled Restart Survival Verification
A second controlled termination and restart of the realtime-server process was performed to verify allowlist persistence:
- **Result**: Post-restart status immediately returned `allowlistConfigured: true` with masked numbers ending in `8000` (customer) and `7000` (staff).
- **Survival Confirmed**: In-memory allowlist state is automatically initialized on boot from environment variables, eliminating reliance on manual post-restart API calls.

---

## 3. Safety Gate Invariants

All live-call safety gates were verified strictly locked:
- `actualAudioIsolationVerified`: **`false`**
- `productionTranslationAuthorized`: **`false`**
- `livePlayback`: **`BLOCKED`**
- `originalBypass`: **`BLOCKED`**
- `emergencyStopEngaged`: **`false`**
- `totalSessionsCreated`: **`0`**

---

## 4. Verification Test Results
- **TypeScript**: `npm.cmd run typecheck --workspaces --if-present` → **PASS** (0 errors).
- **Test Suite**: `npm.cmd test --workspaces --if-present` → **PASS** (406 passed across 42 test files).
- **Restart Regression Test**: `controlledPilot.test.ts` passes, verifying that environment-backed allowlist initialization is enforced on boot.

