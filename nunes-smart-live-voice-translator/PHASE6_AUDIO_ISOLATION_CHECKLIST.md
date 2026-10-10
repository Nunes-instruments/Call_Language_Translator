# PHASE 6: AUDIO ISOLATION VERIFICATION CHECKLIST
## Controlled Pilot Telephony Media Separation & Acoustic Proof Protocol

**Document Version**: 1.0.0  
**Target Environment**: Staging / Controlled Two-Phone Field Pilot  
**Mandatory Safety Invariant**: `actualAudioIsolationVerified = false` until all steps below are executed, physically measured, and signed off.

---

## 1. Scope & Objective

This document defines the strict, reproducible procedure required to prove that **no unintended direct media bridge** exists between the Customer call leg and the Staff call leg.

### The Threat Model
In legacy telephony configurations (such as `<Response><Dial>` bridges), raw RTP/media packets are mixed on Plivo's switch, causing the customer to hear the staff member's un-translated biological voice and vice versa. In an AI translation system, any media leak violates privacy, confuses speakers, and destroys communication clarity.

The **Independent Call-Leg Architecture** eliminates direct bridging by creating two isolated call legs with separate `<Stream>` sessions. This checklist establishes the field protocol to prove that physical carrier-level media isolation holds under live telephony conditions.

---

## 2. Pre-Test Telephony & Acoustic Setup

| Step | Requirement | Operator Verification | Result |
| :---: | :--- | :--- | :---: |
| **0.1** | **Physical Room Separation** | Customer Test Phone (Phone A) and Staff Test Phone (Phone B) must be in physically isolated rooms separated by soundproof doors (minimum 40 dB acoustic isolation) to eliminate acoustic room bleed. | [ ] PASS / [ ] FAIL |
| **0.2** | **Test Phone Numbers** | Both phone numbers must be E.164 verified mobile devices under direct physical possession of authorized pilot operators. | [ ] PASS / [ ] FAIL |
| **0.3** | **External Audio Recorders** | Each phone must be connected to an external direct-line or earphone acoustic recorder capturing the raw audio output heard on that handset. | [ ] PASS / [ ] FAIL |
| **0.4** | **Plivo Console Monitoring** | An operator must have the Plivo Console open to inspect active Call UUIDs, Call Detail Records (CDRs), and XML execution trees in real time. | [ ] PASS / [ ] FAIL |
| **0.5** | **Realtime Server Logging** | Realtime server logs must be set to `level: info` with timestamps to capture WebSocket stream events and audio frame sequences. | [ ] PASS / [ ] FAIL |

---

## 3. Step-by-Step Acoustic & Telephony Verification Protocol

### Phase A: Direct Bridge Absence Verification (Plivo XML & Switch Level)
Verify that Plivo never instantiates a telephony conference or bridging circuit:
- [ ] **A.1 XML Inspection**: Verify in Plivo Console that both inbound/outbound answer URLs returned `<Stream bidirectional="true">` and **ZERO instances** of `<Dial>`, `<Conference>`, `<Speak>`, or `<Play>`.
- [ ] **A.2 Independent Call UUIDs**: Verify in Plivo Console that Customer leg and Staff leg have completely distinct `CallUUID` values and distinct parent billing sessions.
- [ ] **A.3 Track Isolation**: Verify that `<Stream>` XML did NOT declare `audioTrack="both"`. Only server-injected `playAudio` is permitted on the outbound channel.

### Phase B: Customer-to-Staff Acoustic Separation Test
- [ ] **B.1 Customer Speaks**: Operator on Customer Phone (Phone A) speaks Hindi test phrase into handset:
  > *"मुझे फ्लूक 754 प्रेशर कैलिब्रेटर चाहिए"* (Mujhe Fluke 754 pressure calibrator chahiye).
- [ ] **B.2 Biological Voice Bleed Check (Staff Ear)**: While Customer is speaking (0–1200ms), Operator on Staff Phone (Phone B) listens intently:
  - **Expected**: Complete silence or clean comfort noise. **Zero biological customer voice audible**.
  - **Threshold**: Any trace of human customer voice audible before TTS delivery constitutes immediate **FAILURE (MEDIA LEAKAGE)**.
- [ ] **B.3 Translated Audio Delivery**: At approximately 1.5–2.5 seconds, Staff Phone receives synthetic speech:
  - **Expected**: Clear synthetic Tamil voice (`shubh` voice from `bulbul:v3`), e.g., *"எனக்கு Fluke 754 பிரஷர் காலிபிரேட்டர் வேண்டும்"*.
  - **Spectral Signature**: Audio waveform matches Sarvam synthetic speech format, not biological customer pitch.

### Phase C: Staff-to-Customer Acoustic Separation Test
- [ ] **C.1 Staff Speaks**: Operator on Staff Phone (Phone B) speaks Tamil test phrase into handset:
  > *"எங்களிடம் Fluke 754 ஸ்டாக்கில் உள்ளது"* (Engalidam Fluke 754 stock-il ulladhu).
- [ ] **B.2 Biological Voice Bleed Check (Customer Ear)**: While Staff is speaking, Operator on Customer Phone (Phone A) listens intently:
  - **Expected**: Complete silence or clean comfort noise. **Zero biological staff voice audible**.
  - **Threshold**: Any trace of human staff voice audible constitutes immediate **FAILURE (MEDIA LEAKAGE)**.
- [ ] **C.3 Translated Audio Delivery**: At approximately 1.5–2.5 seconds, Customer Phone receives synthetic speech:
  - **Expected**: Clear synthetic Hindi voice from `bulbul:v3`.

### Phase D: Failure & Edge-Case Negative Tests
- [ ] **D.1 TTS Error Failsafe**: With mock or simulated TTS failure injected, speak into Customer Phone.
  - **Verification**: Staff phone remains completely silent. System never falls back to un-translated original speech.
- [ ] **D.2 Single-Leg Hangup**: Hang up Staff Phone (Phone B) while Customer Phone (Phone A) remains connected.
  - **Verification**: Customer Phone does not bridge or hear carrier error tones; Customer leg is torn down cleanly within 1000ms.
- [ ] **D.3 Tamil ↔ Tamil Direct Bypass Lock**: Customer speaks Tamil while Staff speaks Tamil.
  - **Verification**: System logs `ORIGINAL_AUDIO_PATH_UNVERIFIED` and holds audio. It does **NOT** open a direct audio bypass between the callers.
- [ ] **D.4 Barge-in Interruption**: Customer speaks while Staff translation playback is active.
  - **Verification**: Staff phone immediately receives `clearAudio` command, terminating synthetic playback within 250ms.

---

## 4. Formal Sign-Off Table

| Test Gate | Pass Criteria | Result | Verified By | Timestamp |
| :--- | :--- | :---: | :--- | :--- |
| **Gate 1: XML Topology** | 0 `<Dial>` or `<Conference>` tags executed | [ ] PASS | _____________ | ____________ |
| **Gate 2: Customer Audio Isolation** | 0% Customer biological voice heard on Staff handset | [ ] PASS | _____________ | ____________ |
| **Gate 3: Staff Audio Isolation** | 0% Staff biological voice heard on Customer handset | [ ] PASS | _____________ | ____________ |
| **Gate 4: Synthetic Audio Provenance** | Waveform proves `bulbul:v3` synthesis only | [ ] PASS | _____________ | ____________ |
| **Gate 5: Negative Fail-Closed** | TTS failure or bypass lock yields 0 audio leak | [ ] PASS | _____________ | ____________ |

---

## 5. Post-Verification Safety Gate Transition Rule

Under **NO CIRCUMSTANCES** may `actualAudioIsolationVerified` or `productionTranslationAuthorized` be toggled to `true` until:
1. Every checkbox above has been verified and marked **PASS**.
2. Both acoustic recording waveforms have been inspected and archived.
3. The Senior Telephony Engineer and QA Lead have signed this document.

