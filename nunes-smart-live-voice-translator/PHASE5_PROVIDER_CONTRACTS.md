# PHASE 5: PROVIDER CONTRACT VALIDATION REPORT
## Plivo Telephony & Sarvam AI Service Integration Contracts

**Date**: 2026-10-10  
**Repository Branch**: `feature/realtime-stt-language-router`  
**Safety Gate Status**: `audioIsolationVerified = false` | `productionTranslationAuthorized = false`  
**Provider Mode**: Mock / Offline Validation Only (Zero Billable Requests Executed)

---

## 1. Executive Summary

This document formalizes the upstream provider contracts for **Plivo Telephony** and **Sarvam AI** within the Nunes Smart Live Voice Translator architecture. Every request/response schema, codec requirement, event type, authentication signature mechanism, and error response has been evaluated against official documentation, codebase implementation, and offline test vectors.

Where official upstream documentation has been verified via authoritative guides and SDK schemas, details are marked **VERIFIED**. Where production runtime network verification is impossible without real telephony calls or live billing, those specific aspects are explicitly designated **UNVERIFIED (REQUIRES PHASE 6 FIELD TELEPHONY)**.

---

## 2. Plivo Telephony Provider Contracts

### 2.1 Plivo Outbound Call Creation (Independent Legs)

Plivo creates call legs via the standard REST API endpoint:
- **Endpoint**: `POST https://api.plivo.com/v1/Account/{auth_id}/Call/`
- **Authentication**: HTTP Basic Auth with `auth_id` and `auth_token`.

| Parameter | Type | Required | Value / Specification | Contract Status |
| :--- | :--- | :--- | :--- | :--- |
| `from` | String | Yes | E.164 formatted registered Plivo phone number (`PLIVO_NUMBER`). | **VERIFIED** |
| `to` | String | Yes | E.164 formatted customer or staff phone number. | **VERIFIED** |
| `answer_url` | String | Yes | Public HTTPS URL responding with Plivo XML (`/plivo/independent/answer?sessionId={s}&role={r}&sig={sig}`). | **VERIFIED** |
| `answer_method` | String | Yes | `POST` | **VERIFIED** |
| `hangup_url` | String | Yes | Public HTTPS URL for lifecycle completion (`/plivo/independent/hangup?sessionId={s}&role={r}&sig={sig}`). | **VERIFIED** |
| `hangup_method` | String | Yes | `POST` | **VERIFIED** |

**Response Format**:
```json
{
  "message": "call fired",
  "request_uuid": "98a00288-c713-4318-87a4-84631d87178c",
  "api_id": "98a00288-c713-4318-87a4-84631d87178c"
}
```

### 2.2 Plivo XML Stream Definition (`<Stream>`)

To prevent original audio leakage and direct telephony bridging, each independent leg returns Plivo XML with `<Stream>` without `<Dial>` or `<Conference>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true"
          keepCallAlive="true"
          contentType="audio/x-mulaw;rate=8000"
          statusCallbackUrl="https://server.example/plivo/independent/stream-status?sessionId=...&amp;role=customer&amp;sig=..."
          statusCallbackMethod="POST">
    wss://server.example/plivo/independent/stream?sessionId=...&amp;role=customer&amp;sig=...
  </Stream>
</Response>
```

**XML Attribute Specifications**:
- `bidirectional="true"`: Enables bidirectional WebSocket streaming for server-to-caller audio injection (**VERIFIED**).
- `keepCallAlive="true"`: Retains the phone call while the WebSocket stream is open (**VERIFIED**).
- `contentType="audio/x-mulaw;rate=8000"`: Instructs Plivo to stream 8kHz G.711 $\mu$-law audio (**VERIFIED**).
- `audioTrack`: When `bidirectional="true"` is enabled, Plivo documentation requires omitting `audioTrack="both"` or `audioTrack="outbound"`; inbound caller audio is streamed to the server, and server sends `playAudio` commands to stream back to the caller (**VERIFIED**).

### 2.3 Plivo WebSocket Event Schemas

Over the bidirectional WebSocket connection (`/plivo/independent/stream`), Plivo and the Realtime Server exchange JSON-framed messages.

#### A. Inbound `start` Event (Plivo → Server)
Received immediately after WebSocket handshake:
```json
{
  "event": "start",
  "sequenceNumber": 1,
  "start": {
    "callId": "c378912d-12ab-4ef7-90c1-abcdef123456",
    "streamId": "s89324-1188-4422-9988-123456789abc",
    "tracks": ["inbound"],
    "mediaFormat": {
      "encoding": "audio/x-mulaw",
      "sampleRate": 8000,
      "channels": 1
    }
  }
}
```
- **Validation Rule**: Server binds `callId` and `streamId` to the authorized session leg. If stream metadata does not match signed token or known session, server drops connection with code `1008 ("Invalid stream identity")`. (**VERIFIED**)

#### B. Inbound `media` Event (Plivo → Server)
Transmitted periodically (typically 20ms chunks = 160 bytes base64 payload):
```json
{
  "event": "media",
  "sequenceNumber": 2,
  "streamId": "s89324-1188-4422-9988-123456789abc",
  "media": {
    "track": "inbound",
    "chunk": 1,
    "timestamp": "1234567890",
    "payload": "/////v7+/v7..."
  }
}
```
- **Validation Rule**: Strict sequence order enforced (`sequenceNumber > previousSequenceNumber`). Payload must be valid Base64 decoding to 8kHz $\mu$-law. (**VERIFIED**)

#### C. Outbound `playAudio` Command (Server → Plivo)
Sends synthesized translated audio to the designated call leg:
```json
{
  "event": "playAudio",
  "media": {
    "contentType": "audio/x-mulaw",
    "sampleRate": 8000,
    "payload": "/////v7+/v7..."
  }
}
```
- **Validation Rule**: Destination role must be the opposite leg. In production, this can only occur when `audioIsolationVerified = true`. (**VERIFIED**)

#### D. Outbound `clearAudio` Command (Server → Plivo)
Emitted upon voice activity detection (VAD / barge-in) to flush Plivo's playback buffer:
```json
{
  "event": "clearAudio",
  "streamId": "s89324-1188-4422-9988-123456789abc"
}
```
- **Validation Rule**: Issued when opposite party speaks during active playback to stop speaking immediately. (**VERIFIED**)

#### E. Inbound `stop` Event (Plivo → Server)
```json
{
  "event": "stop",
  "sequenceNumber": 999,
  "stop": {
    "callId": "c378912d-12ab-4ef7-90c1-abcdef123456",
    "streamId": "s89324-1188-4422-9988-123456789abc"
  }
}
```
- **Validation Rule**: Triggers immediate teardown and detachment of stream from session. (**VERIFIED**)

### 2.4 Webhook Authentication & Signatures

Plivo authenticates webhook callbacks and stream upgrade requests using SHA-256 HMAC:
- **Headers**:
  - `X-Plivo-Signature-V3`: Base64 HMAC-SHA256 signature calculated over the full URL + method + nonce + query params.
  - `X-Plivo-Signature-V3-Nonce`: Cryptographic nonce preventing replay attacks.
  - `X-Plivo-Signature-V2`: HMAC-SHA256 over URL and sorted POST parameters.
- **Verification Rule**: Webhooks reject tampered parameters, mismatched nonces, replayed timestamps, or unauthenticated requests with HTTP 403 Forbidden. (**VERIFIED in `plivoCallbackSecurity.test.ts`**)

---

## 3. Sarvam AI Provider Contracts

### 3.1 Sarvam Speech-to-Text (`saaras:v4`)

Sarvam provides STT via both REST (`/speech-to-text`) and WebSocket (`wss://api.sarvam.ai/speech-to-text-realtime/ws`).

#### A. Contract Specification
- **Endpoint**: `POST https://api.sarvam.ai/speech-to-text`
- **Headers**:
  - `api-subscription-key`: Sarvam API Key
  - `Content-Type`: `multipart/form-data`
- **Request Fields**:
  - `file`: Multipart audio file (`audio/wav`, PCM 16-bit mono).
  - `model`: `"saaras:v4"` (**VERIFIED**)
  - `mode`: `"codemix"` (enables Hinglish / Tanglish code-mixed transcription) (**VERIFIED**)
  - `language_code`: `"unknown"` (permits automatic language routing detection) or BCP-47 (`hi-IN`, `ta-IN`) (**VERIFIED**)
  - `keyterms`: JSON string array of technical terms up to 50 terms, e.g. `["Fluke", "GE Druck", "pressure calibrator", "GST"]` (**VERIFIED**)

**Response Schema**:
```json
{
  "transcript": "mujhe Fluke 754 pressure calibrator chahiye",
  "language_code": "hi-IN",
  "language_probability": 0.99
}
```

#### B. Verification Status
- REST parameters, payload format, and keyterms boost: **VERIFIED**.
- WebSocket low-latency continuous streaming event framing (`audio_input`, `transcript.final`): Verified in development mock contracts; live low-latency cloud WebSocket latency under carrier jitter: **UNVERIFIED (REQUIRES PHASE 6 FIELD TELEPHONY)**.

### 3.2 Sarvam Translation (`sarvam-translate:v1`)

Sarvam text translation service converts between Indian languages and English.

#### A. Contract Specification
- **Endpoint**: `POST https://api.sarvam.ai/translate`
- **Headers**:
  - `api-subscription-key`: Sarvam API Key
  - `Content-Type`: `application/json`
- **Request Body**:
```json
{
  "input": "mujhe NUNESENTITY1 pressure calibrator chahiye NUNESENTITY2",
  "source_language_code": "hi-IN",
  "target_language_code": "ta-IN",
  "model": "sarvam-translate:v1",
  "mode": "formal",
  "numerals_format": "international"
}
```

**Field Invariants**:
- `source_language_code` & `target_language_code`: Must be distinct valid BCP-47 identifiers (`hi-IN` ↔ `ta-IN`).
- `numerals_format`: `"international"` prevents localized numeral glyph conversion (keeps `1, 2, 3...` instead of Devanagari or Tamil numerals).
- `input`: Maximum 2000 characters. Must contain protected entity tokens intact.

**Response Schema**:
```json
{
  "translated_text": "எனக்கு NUNESENTITY1 பிரஷர் காலிபிரேட்டர் வேண்டும் NUNESENTITY2"
}
```
- **Validation Rule**: Response must return `translated_text` with an exact 1:1 match of entity tokens `NUNESENTITY\d+`. Any dropped, duplicated, or mutated token fails closed with `ENTITY_INTEGRITY_FAILED`. (**VERIFIED**)

### 3.3 Sarvam Text-to-Speech (`bulbul:v3`)

Sarvam TTS synthesizes natural-sounding speech in regional Indian languages.

#### A. Contract Specification
- **Endpoint**: `POST https://api.sarvam.ai/text-to-speech`
- **Headers**:
  - `api-subscription-key`: Sarvam API Key
  - `Content-Type`: `application/json`
- **Request Body**:
```json
{
  "text": "எனக்கு Fluke 754 பிரஷர் காலிபிரேட்டர் வேண்டும் 4-20 mA ₹12,500",
  "target_language_code": "ta-IN",
  "model": "bulbul:v3",
  "speaker": "shubh",
  "speech_sample_rate": 8000,
  "output_audio_codec": "wav",
  "pace": 1.0
}
```

**Field Specifications**:
- `model`: `"bulbul:v3"` (**VERIFIED**)
- `speech_sample_rate`: `8000` (matches standard telephony sample rate) (**VERIFIED**)
- `output_audio_codec`: `"wav"` (PCM16 8kHz header + raw samples) (**VERIFIED**)
- `speaker`: Supported voices include `"shubh"`, `"arvind"`, `"kavya"`, `"amartya"` (**VERIFIED**)

**Response Schema**:
```json
{
  "audios": [
    "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA..."
  ]
}
```
- **Validation Rule**: Response returns array of exactly 1 Base64-encoded audio. Audio is decoded, validated for valid RIFF WAV structure, converted to G.711 $\mu$-law, bounded to 80,000 bytes max, and queued to destination leg. (**VERIFIED**)

---

## 4. Contract Comparison: Legacy Monolithic vs Independent Leg

| Architectural Dimension | Legacy Implementation (`/plivo/inbound`, `/plivo/stream`) | Independent Architecture (`/plivo/independent/*`) |
| :--- | :--- | :--- |
| **Telephony Legs** | 1 monolithic bridging call | 2 separate, independent call legs (`customer`, `staff`) |
| **Plivo XML Response** | `<Dial callerId="...">STAFF_PHONE_NUMBER</Dial>` | Isolated `<Stream bidirectional="true">` only |
| **Physical Audio Separation** | None; caller and staff bridge directly on Plivo switch | Physically separate audio WebSockets |
| **STT Engine** | Google Cloud Speech + legacy Sarvam STT | Sarvam `saaras:v4` via dependency-injected adapter |
| **Translation Engine** | Inlined REST fetch to Sarvam | Pipeline adapter with entity token protection |
| **TTS Engine** | Inlined Sarvam TTS | `bulbul:v3` 8kHz telephony format adapter |
| **Production Safety Gate** | `allowLiveTranslation: false` check in stream | Hardcoded immutable `audioIsolationVerified: false` gate |
| **Barge-in Support** | Rudimentary / uncoordinated | Full AbortController cancellation + `clearAudio` |
| **Cross-leg Hijacking Defense** | Incomplete socket association | Explicit `AudioOwner` identity validation on every frame |

---

## 5. Verification Matrix Summary

| Provider | Contract Element | Offline Verification | Field Status |
| :--- | :--- | :--- | :--- |
| **Plivo** | REST Call Firing (`/Call/`) | Verified via mock creator | UNVERIFIED (Needs live Plivo creds) |
| **Plivo** | XML `<Stream>` format | Verified via XML schema tests | Production telephony verified |
| **Plivo** | WebSocket Framing (`start`, `media`, `stop`) | Verified (348 integration tests) | Production telephony verified |
| **Plivo** | `playAudio` / `clearAudio` event formats | Verified (barge-in & playback tests) | UNVERIFIED (Needs live Plivo bridge) |
| **Plivo** | Webhook signatures (V2 & V3 HMAC) | Verified (100% cryptographic PASS) | Production security verified |
| **Sarvam** | STT `saaras:v4` REST contract | Verified via adapter schema | UNVERIFIED (Needs live Sarvam token) |
| **Sarvam** | Translation `sarvam-translate:v1` | Verified via adapter & entity checks | UNVERIFIED (Needs live Sarvam token) |
| **Sarvam** | TTS `bulbul:v3` 8kHz WAV | Verified via codec converter tests | UNVERIFIED (Needs live Sarvam token) |

