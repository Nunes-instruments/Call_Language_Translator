# NUNES SMART LIVE VOICE TRANSLATOR — REAL-PROVIDER TEST READINESS & VALIDATION PLAN

## Document Control
- **Date**: 2026-10-10
- **Branch**: `feature/realtime-stt-language-router`
- **Public Origin**: `https://remote-material-staple.ngrok-free.dev`
- **Active Allowlist (Masked)**: Customer `+********8000`, Staff `+********7000`
- **Offline Tests Passing**: **406 passed across 42 test files**
- **TypeScript**: **0 errors across 5 workspaces**
- **Safety Gate Status**: **STRICTLY LOCKED**
  - `actualAudioIsolationVerified`: **`false`**
  - `productionTranslationAuthorized`: **`false`**
  - `livePlayback`: **`BLOCKED`**
  - `originalBypass`: **`BLOCKED`**
  - `INDEPENDENT_LIVE_CALLS_APPROVED`: **`false as const`**

---

## 1. Plivo Bidirectional Media Streaming & Codec Specifications

### 1.1 Inbound Media Stream Format
From inspecting [`independentCallLegXml.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallLegXml.ts) and [`telephonyAudioCodec.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/telephonyAudioCodec.ts):
- **Encoding**: ITU-T G.711 $\mu$-law (`audio/x-mulaw;rate=8000`).
- **Sample Rate**: 8,000 samples per second.
- **Channels**: 1 (mono), 8 bits per sample.
- **Frame Duration**: 20 ms per packet (standard telephony framing).
- **Packet Size**: 160 bytes of raw $\mu$-law payload per frame (encoded as base64 string ~216 characters).
- **Transport**: JSON messages sent over a persistent WebSocket (`wss://.../plivo/independent/stream`).

### 1.2 WebSocket Event Contract
The installed WebSocket handler in [`independentCallFeature.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallFeature.ts) enforces the following schemas:

1. **`start` Event**:
   ```json
   {
     "event": "start",
     "sequenceNumber": 1,
     "start": {
       "streamId": "<uuid>",
       "callId": "<call-uuid>",
       "tracks": ["inbound"],
       "mediaFormat": {
         "encoding": "audio/x-mulaw",
         "sampleRate": 8000,
         "channels": 1
       }
     },
     "streamId": "<uuid>"
   }
   ```
2. **`media` Event**:
   ```json
   {
     "event": "media",
     "sequenceNumber": 2,
     "media": {
       "track": "inbound",
       "chunk": 1,
       "timestamp": 160,
       "payload": "<base64-encoded-mulaw-audio>"
     },
     "streamId": "<uuid>"
   }
   ```
   *Validation Constraints*:
   - Strict monotonic `sequenceNumber` ordering (`sequenceNumber > lastSequence`).
   - Base64 payload validation with max length ceiling (22,000 bytes).
   - Matching `streamId` bound to the leg's authenticated owner.
3. **`stop` Event**:
   ```json
   {
     "event": "stop",
     "sequenceNumber": 3,
     "stop": { "callId": "<call-uuid>" },
     "streamId": "<uuid>"
   }
   ```
   *Action*: Detaches stream socket, closes connection cleanly with code 1000.

---

## 2. Receive-Only Media Validation Architecture (Zero Playback Transmission)

To validate real carrier audio, sample rates, and WebSocket stability without any risk of acoustic feedback or unauthorized playback:

1. **Receive-Only State (Zero Playback Sink)**:
   - In [`independentCallOrchestrator.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallOrchestrator.ts), the `media()` handler processes inbound frames into `runtime.pipelines[role]`, measuring:
     - `frames` count.
     - `bytes` received.
     - `lastSequence`.
   - **Crucial Invariant**: In [`independentCallFeature.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentCallFeature.ts), the WebSocket connection has **no `socket.send()` loop** wired to outgoing audio. Outgoing media playback frames (`playAudio`) are structurally absent from the live WebSocket router.
   - Even if translation was running in mock mode, synthesized audio is stored in an in-memory queue (`queues.customer` / `queues.staff`) and **only drained into test sinks**.
2. **Hardcoded Call-Approval Gate**:
   - In [`independentPlivoCallCreator.ts`](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/apps/realtime-server/src/independentPlivoCallCreator.ts):
     ```typescript
     export const INDEPENDENT_LIVE_CALLS_APPROVED = false as const;
     ```
   - This gate is hardcoded as `false` in compiled source.
   - Any execution of `PlivoIndependentCallProvider.createLeg()` unconditionally throws:
     `LIVE_CALL_APPROVAL_REQUIRED`.
   - **Finding**: Currently, **no real phone calls can be placed under any circumstance**, even if an operator triggers the session endpoint.

---

## 3. Measurable Pass / Fail Evaluation Criteria

For any future live validation stage, the test must evaluate these quantitative metrics:

| Metric | Target / Pass Criteria | Failure Trigger | Evidence / Verification Method |
|---|---|---|---|
| **Carrier Frame Rate** | 50 packets/sec ($\pm 5\%$) | $> 20\%$ packet jitter or drift | Measured via `pipeline.frames` over elapsed seconds |
| **Audio Format Compliance** | 8000 Hz $\mu$-law mono | Invalid base64 or unsupported sample rate | `decodeMulaw()` and RMS speech amplitude $> 500$ |
| **Leg Ownership Isolation** | 100% 1:1 leg binding | Cross-leg socket sharing or stream collision | Rejection with `SOCKET_ALREADY_OWNED` |
| **Physical Isolation** | Zero audio leakage | Staff audio heard directly by customer or vice versa | Separate handset acoustic test in isolated rooms |
| **Round-Trip Latency** | $< 1.5$ seconds | $> 2.0$ seconds sustained latency | Measured across STT + translation + TTS stages |
| **Barge-in / Interruption** | $< 300$ ms interruption response | Delayed playback after interruption | Timestamp of voiced speech vs. opposite leg queue flush |
| **Emergency STOP Speed** | $< 1000$ ms to hangup | Call remains active after STOP | Plivo call status polling post `emergencyStop()` |

---

## 4. Exact Code Changes Required for a Future Limited Test (Not Implemented)

To enable a strictly controlled two-phone live test in the future, the following minimal, targeted code changes would be required:

1. **`apps/realtime-server/src/independentPlivoCallCreator.ts`**:
   - Change `export const INDEPENDENT_LIVE_CALLS_APPROVED = false as const;` to an operator-authorized conditional or explicit constant after formal signoff.
2. **`apps/realtime-server/src/independentCallFeature.ts`**:
   - Wire a restricted, receive-only logging sink or field-verification drainage handler (`drainFieldVerification()`) that logs frame count and sample rate telemetry without transmitting audio.
3. **Zero Changes to Production Gates**:
   - `productionPlayback(): never` must remain throwing `AUDIO_ISOLATION_UNVERIFIED`.
   - `gates.actualAudioIsolationVerified` must remain `false`.

---

## 5. Rollback Procedure & Emergency Controls

If any anomaly occurs during a test:
1. **Immediate In-Flight Termination**:
   Execute the Emergency STOP command from the operator terminal:
   ```powershell
   $headers = @{ "Authorization" = "Bearer $env:NUNES_ADMIN_PASSWORD"; "Content-Type" = "application/json" }
   Invoke-RestMethod -Uri "https://remote-material-staple.ngrok-free.dev/management/pilot/emergency-stop" -Method Post -Headers $headers -Body '{"reason":"Operator emergency stop"}'
   ```
2. **Plivo Account-Level Fail-Safe**:
   In the Plivo console, terminate active calls via the Call Detail Records dashboard if server connectivity is lost.
3. **Process Shutdown**:
   ```powershell
   Get-NetTCPConnection -LocalPort 8787 | Select-Object OwningProcess
   Stop-Process -Id <PID> -Force
   ```
4. **Environment Rollback**:
   Restore `.env` from `.env.backup.*` and restart server.

---

## 6. Pre-Test Operator Checklist

- [ ] **1. Physical Handset Separation**:
  - Handset A (Customer: `+919087768000`) in Room A (closed door).
  - Handset B (Staff: `+919159267000`) in Room B (closed door, $>10$ meters distance).
  - Both handsets equipped with headsets to eliminate ambient speaker-mic coupling.
- [ ] **2. Public Connectivity**:
  - `curl https://remote-material-staple.ngrok-free.dev/health` returns `200 OK`.
  - Database status is `CONNECTED`.
- [ ] **3. Active Allowlist**:
  - `GET /management/pilot/status` confirms masked endings `8000` and `7000`.
- [ ] **4. Budget & Timer Hard Limits**:
  - Max duration: 180 seconds.
  - Max budget: $2.00 USD.
- [ ] **5. Safety Gates**:
  - `actualAudioIsolationVerified`: `false`.
  - `livePlayback`: `BLOCKED`.
  - `originalBypass`: `BLOCKED`.
- [ ] **6. Emergency STOP Ready**:
  - PowerShell window open with emergency STOP command prepared.

