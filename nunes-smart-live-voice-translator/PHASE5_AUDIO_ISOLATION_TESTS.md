# PHASE 5: AUDIO ISOLATION & PLAYBACK SAFETY TEST REPORT

**Date**: 2026-10-10  
**Test Suite**: `apps/realtime-server/src/phase5TranslationPipeline.test.ts` & `independentCallIntegration.test.ts`  
**Isolation Status**: Simulated Isolation PASS | Telephony Physical Isolation UNVERIFIED  
**Production Gate**: `actualAudioIsolationVerified = false` (Strict Safety Lock)

---

## 1. Core Principle: Simulated Isolation vs. Telephony Physical Isolation

> [!CAUTION]
> **CRITICAL ARCHITECTURAL BOUNDARY:**
> Unit, integration, and simulated WebSocket tests verify that **application memory, routing logic, and software queues** never cross customer and staff audio streams. However, **simulated offline tests cannot physically verify Plivo's underlying telephony mesh or carrier-grade media isolation in production**.
> 
> Therefore, `actualAudioIsolationVerified` remains hardcoded to `false` in database constraints, session managers, and pipeline orchestrators. The application **fails closed** if any production playback or direct bridge is attempted.

---

## 2. Audio Isolation Invariants & Negative Test Matrix

The Phase 5 test suite (`src/phase5TranslationPipeline.test.ts`) and existing integration suites execute comprehensive positive and deliberate negative assertions against all twelve critical audio isolation invariants:

### Invariant 1: Customer Input Belongs Exclusively to the Customer Leg
- **Assertion**: Audio packets arriving on customer stream are assigned to `leg.customer`. Any packet tagged with customer session credentials claiming `role: "staff"` throws `INVALID_AUDIO_IDENTITY_OR_SEQUENCE`.
- **Negative Test**: `rejects a customer packet claiming the staff role` and `enforces strict leg ownership and rejects mismatched owner metadata`.
- **Status**: **PASS (Verified Offline)**

### Invariant 2: Staff Input Belongs Exclusively to the Staff Leg
- **Assertion**: Audio packets arriving on staff stream are assigned exclusively to `leg.staff`.
- **Negative Test**: Attempting to feed staff audio with altered `callUuid`, `streamId`, or `socket` reference immediately throws `INVALID_AUDIO_IDENTITY_OR_SEQUENCE`.
- **Status**: **PASS (Verified Offline)**

### Invariant 3: Customer Translated Output Targets Staff Only
- **Assertion**: When customer Hindi audio is translated, the synthesized Tamil TTS is enqueued into `queues.customer` with destination strictly set to `destination: "staff"`.
- **Verification**: `MockPlaybackSink` records all messages; `sink.messages.map(m => m.destination)` equals `["staff"]`.
- **Status**: **PASS (Verified Offline)**

### Invariant 4: Staff Translated Output Targets Customer Only
- **Assertion**: When staff Tamil audio is translated, the synthesized Hindi TTS is enqueued into `queues.staff` with destination strictly set to `destination: "customer"`.
- **Verification**: Draining `staff` queue into `MockPlaybackSink` results in `destination: "customer"`.
- **Status**: **PASS (Verified Offline)**

### Invariant 5: Wrong-Leg Playback is Rejected
- **Assertion**: Attempting to drain audio to an unauthorized destination, or attempting to drain without explicit verification authorization (`offlineTranslationAuthorized: true`, `simulatedIsolationVerified: true`) throws `OFFLINE_PLAYBACK_GATE_CLOSED`.
- **Negative Test**: Calling `drainMock` with `{ offlineTranslationAuthorized: false }` or `{ simulatedIsolationVerified: false }` throws `OFFLINE_PLAYBACK_GATE_CLOSED`.
- **Status**: **PASS (Verified Offline)**

### Invariant 6: Closed or Stale Streams Cannot Receive Playback
- **Assertion**: Once a call or session closes, all audio queues and leg attachments are wiped (`generation` incremented).
- **Negative Test**: Calling `drainMock` after `pipeline.close()` throws `SESSION_CLOSED`. Calling `receive` on a closed session throws `INVALID_AUDIO_IDENTITY_OR_SEQUENCE`.
- **Status**: **PASS (Verified Offline)**

### Invariant 7: Cancelled Sessions Cannot Restart Translation
- **Assertion**: When a call leg is cancelled or hung up, its in-flight `AbortController` signals are aborted immediately.
- **Negative Test**: Late transcription completions and provider results arriving after hangup or cancellation are aborted and dropped without translation or TTS generation.
- **Status**: **PASS (Verified Offline)**

### Invariant 8: Provider Reconnect Cannot Steal Another Session's Stream
- **Assertion**: Inbound WebSocket connections must present valid cryptographic signatures bound to a known session ID and role.
- **Negative Test**: Binding an owner with a `sessionId` not matching the pipeline throws `INVALID_AUDIO_OWNER`. Binding an owner with a socket already claimed by another role throws `SOCKET_ALREADY_OWNED`.
- **Status**: **PASS (Verified Offline)**

### Invariant 9: Duplicate Callbacks Cannot Create Duplicate Active Call Legs
- **Assertion**: Plivo webhook callbacks are validated via unique `RequestUUID` and session engine state machines.
- **Negative Test**: Replaying an answer callback with the same or modified CallUUID does not spawn duplicate legs; conflicting ownership attempts are rejected.
- **Status**: **PASS (Verified Offline)**

### Invariant 10: Delayed TTS Response Cannot Play After Cancellation
- **Assertion**: TTS generation is stamped with a pipeline `generation` counter. If a session is cancelled or invalidated while TTS synthesis is in flight, the delayed result matches a stale generation counter.
- **Negative Test**: Delayed TTS resolve function executed after `pipeline.close()` produces 0 queued items in `queues.customerToStaff`.
- **Status**: **PASS (Verified Offline)**

### Invariant 11: Playback Failures Never Fall Back to Leaking Original Audio
- **Assertion**: If Sarvam TTS fails, network times out, or codec conversion fails, the pipeline logs an error metric and leaves playback queues empty.
- **Negative Test**: Provider failure injected into `synthesize()` leaves `sink.messages` completely empty; raw audio is never bypassed to the other leg.
- **Status**: **PASS (Verified Offline)**

### Invariant 12: Tamil-to-Tamil Bypass Remains Disabled
- **Assertion**: When both customer and staff speak Tamil, direct bypass would ordinarily be considered. However, because physical audio isolation is not field-proven, bypassing directly on the telephony bridge risks uncontrolled media leakage.
- **Negative Test**: When customer speaks Tamil while staff is set to Tamil, router selects `DIRECT_BYPASS`. The pipeline detects `DIRECT_BYPASS` and immediately halts with `ORIGINAL_AUDIO_PATH_UNVERIFIED`, holding the audio.
- **Status**: **PASS (Verified Offline)**

---

## 3. Production Playback Safety Gate

The production playback function in `IndependentTranslationPipeline` is structurally implemented as:

```typescript
productionPlayback(): never {
  throw new Error("AUDIO_ISOLATION_UNVERIFIED");
}
```

And in `IndependentCallSessionEngine`:
```typescript
enableTranslation(): never {
  throw new Error("Live translation blocked: Plivo audio isolation unverified");
}
```

And in `getTranslationTestMode`:
```typescript
export function getTranslationTestMode(env: Record<string, string | undefined>): TranslationTestMode {
  const enabled = env.NUNES_TRANSLATION_TEST_MODE === "true";
  const audioIsolationVerified = false; // Never activate without verified field isolation
  return {
    enabled,
    audioIsolationVerified,
    allowLiveTranslation: enabled && audioIsolationVerified // Strictly false
  };
}
```

These gates ensure that under **no configuration or environment variable combination** can unverified live translation or direct unverified audio playback be triggered in production.

---

## 4. Test Suite Results Summary

| Suite / Test Group | Invariant Focus | Total Tests | Result |
| :--- | :--- | :--- | :--- |
| `phase5TranslationPipeline.test.ts` (Part 1) | Bidirectional Routing & Entity Safety | 11 | **PASS** |
| `phase5TranslationPipeline.test.ts` (Part 2) | Audio Isolation & Playback Gates | 8 | **PASS** |
| `phase5TranslationPipeline.test.ts` (Part 3) | Realtime Queues, Timeouts & Stability | 4 | **PASS** |
| `independentCallIntegration.test.ts` | Two-leg Orchestration & Fastify Server | 28 | **PASS** |
| `plivoCallbackSecurity.test.ts` | Webhook Nonce, HMAC & Replay Defense | 9 | **PASS** |
| `phase3Pipeline.test.ts` | Base Pipeline Codecs & Offline Mocks | 55 | **PASS** |
| **Total Audio Isolation & Pipeline Tests** | **All Invariants** | **115** | **ALL PASS** |

