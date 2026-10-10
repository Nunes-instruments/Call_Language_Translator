# Phase 3 — offline bidirectional translation

Implemented locally on `feature/realtime-stt-language-router`, 9 October 2026. Phase 1 and Phase 2 reports and implementations were inspected first. No calls, billable API requests, deployment, commit, push, credential changes or production authorization occurred. The existing direct bridge remains available; Phase 3 adds processing only to independent call sessions.

## Task results

| Task | Result | Evidence and limits |
| --- | --- | --- |
| 1. Plivo media contract | PASS documentation review; BLOCKED actual provider proof | Installed Plivo 4.79.0 SDK signature validation and authoritative streaming reference inspected. No real media session tested. |
| 2. Secure shared coordinator | PASS offline | Authenticated orchestrator binds each session/role/call UUID/stream ID/socket to the session pipeline. Independent directional queues; stale ownership and sequence rejection; bounded buffers; disconnect/reconnect/hangup cancellation. |
| 3. Sarvam adapters | PASS mock contract adapters; BLOCKED real compatibility proof | Configurable exact models, STT WAV upload descriptor, translation JSON descriptor, TTS WAV validation/conversion. Injected mock transports only. |
| 4. Hindi/Hinglish to Tamil | PASS offline | Authenticated mu-law audio → PCM → segmentation → final STT → language router → entity masking → translation → Tamil TTS → staff queue. |
| 5. Tamil/Tanglish to Hindi | PASS offline | Separate staff pipeline with Tamil default → Hindi TTS → customer queue; waits for established Hindi customer language. |
| 6. Smart language routing | PASS safe routing; BLOCKED original bypass | Existing router and mixed-language detector reused. Unknown, weak, partial and conflicting speech held. Tamil/Tamil selects a blocked original-path state without translation/TTS. |
| 7. Audio processing | PASS offline baseline; BLOCKED real quality/latency proof | RMS segmentation, ordered bounded jobs, deadlines, aborts, exact mock echo suppression, mock barge-in clearing, stage timings. REST final transcripts only; partial results held. |
| 8. Isolation safety | PASS locked gates; BLOCKED real isolation | Simulated isolation/document review separate from immutable actual-isolation=false and production-authorization=false. No actual output transport exists. |
| 9. Automated verification | PASS | Full baseline suite retained; new codec/provider/pipeline tests and signed WebSocket integration. Counts below. |
| 10. Report and next phase | PASS | This report, reproducible offline benchmark and Phase 4 plan. |

## Architecture and limits

`independentCallFeature` defaults offline translation off. Enabling `NUNES_OFFLINE_TRANSLATION_ENABLED` also requires existing independent-call test mode. This creates scripted mocks, never a live client. The default mock has no transcripts, so it holds speech safely. Useful simulations inject scripted transcript/translation/TTS fixtures. The fixture translation function defaults to identity; it exercises orchestration, not linguistic correctness.

The existing orchestrator still requires authenticated upgrade, capability token, answered call identity and signed stream status before accepting media. Only then does it bind the new `IndependentTranslationPipeline`. Each session owns customer/staff state and separate customer-to-staff and staff-to-customer queues. A binding change increments the shared generation, aborts pending stages and discards prepared audio; disconnect also resets language evidence. Late results cannot survive reconnect or close.

Input is strict canonical base64, mu-law, 8 kHz, inbound only. Frames are limited to 16,000 bytes. RMS threshold 500 starts speech; 300 ms silence ends an utterance; the 32,000-byte threshold forces a segment at a frame boundary (up to 48,000 bytes with the largest permitted frame). Segments under 800 bytes are held. Each direction permits four pending jobs and four prepared outputs, with a 128,000-byte prepared queue cap and 80,000-byte output cap. Overflow flushes the generation. Diagnostic timing history and mock sink history are bounded to 32 entries each.

Jobs run serially per direction. Each STT/translation/TTS stage has a two-second default deadline and at most one retry for explicitly retryable failures. Timeout is not retried. Cancellation propagates through AbortSignal and rejects even mocks that ignore abort. Provider messages are sanitized; transcripts and audio are not returned by status diagnostics.

Customer evidence uses the existing Tamil-staff SmartLanguageRouter. Staff settings remain Tamil. Current unknown/weak observations cannot inherit a previous active decision. Staff-first utterances are held/dropped until customer Hindi is established. Romanized and native-script lexical heuristics assist code mixing but are not perfect detection. Missing confidence stays uncertain. Only final transcripts translate; partial mock transcripts are held rather than synthesized.

Technical names, model identifiers, quantities, currency, percentages and measurements are masked before translation and restored before TTS. Missing, duplicated or unknown entity tokens fail closed; input token collisions are rejected. Restoration now distinguishes token 1 from token 10. This protects recognized transcript entities, not errors already made by STT.

`MockPlaybackSink` records only simulated `playAudio` and `clearAudio` messages. Explicit offline translation authorization AND simulated isolation are needed to drain it. It holds no WebSocket or network client. Actual playback always throws `AUDIO_ISOLATION_UNVERIFIED`. Barge-in cancels work/queued audio destined for the speaking leg and records a mock clear on authorized drain. Echo protection recognizes an exact recent simulated TTS payload; this is not acoustic echo cancellation and cannot establish real-call isolation.

Tamil/Tamil original bypass is intentionally BLOCKED: the independent architecture has no verified original-audio transport. Initial STT is still needed to identify the language; no untranslated speech is silently injected, and no claim of STT-free established bypass is made.

## Plivo contract findings

The [audio streaming reference](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-reference) documents start/media identity and format fields, base64 media, `playAudio`, `clearAudio` and checkpoints. Prepared playback uses `media.contentType=audio/x-mulaw`, `sampleRate=8000` and base64 payload. Mock clear includes the destination stream ID. Incoming stream ownership is checked against signed callbacks, not trusted merely because a WebSocket message names an ID.

The [Stream XML reference](https://www.plivo.com/docs/voice/xml/audio-streaming) and [streaming guide](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide) describe inbound bidirectional streams and keep-call-alive behavior. Existing independent XML contains Stream/Hangup without Dial/Conference, allowing each created call its own intended inbound stream. This architecture is an inference from documented primitives, not proof that original voice cannot leak in a real provider session. Real callback ordering, format, caller audibility, interruption and buffering still need controlled provider validation. Installed SDK V3 signature helpers remain the authority for canonicalization; existing real-SDK offline signature tests remain intact.

## Sarvam contract findings

The [STT REST reference](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe) documents multipart audio, `saaras:v4`, language auto-detection via `unknown`, and optional language probability. The adapter describes an 8 kHz mono PCM16 WAV upload, codemix and JSON keyterms. It does not send the request. [API selection guidance](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/which-api-to-use) distinguishes REST and realtime interfaces. Model/mode and streaming guidance contain version-specific wording; this implementation uses final REST-shaped responses and does not claim proven v4 live partial transcription.

The [translation reference](https://docs.sarvam.ai/api-reference/text/translate-text) defines `sarvam-translate:v1`, source/target codes, formal mode and translated-text output. Directions are explicitly hi-IN→ta-IN and ta-IN→hi-IN; input is bounded to 2,000 characters. No conversational or chatbot replies are generated.

The [TTS REST reference](https://docs.sarvam.ai/api-reference/text-to-speech/convert) defines `bulbul:v3`, speaker, target language, sampling and base64 audio output. The adapter requests WAV at 8 kHz and validates mono PCM16 before mu-law encoding. It also supports integer-rate conversion from validated 16/24 kHz WAV; this basic box-filter downsampling requires listening tests before production. [HTTP streaming guidance](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/http-stream) describes a distinct endpoint/codec surface. Legacy raw REST mu-law assumptions are not reused. Actual endpoint acceptance, voice availability, token preservation, codec/container shape and audio quality remain BLOCKED until separately authorized non-mock validation.

## Verification and measured offline latency

Commands: `npm.cmd test`, `npm.cmd run typecheck`, `git diff --check`, and `npx.cmd tsx scripts/phase3-offline-benchmark.ts`.

All workspace TypeScript checks passed. Full suite: **319 tests passed in 38 files** (289 realtime-server, 26 language-router, 4 translation), including all 263 Phase 2 tests and 56 added tests. Signed Fastify/WebSocket integration covers media reaching the mock queue and verifies zero playback messages to connected sockets. New tests cover both directions, code mixing, wrong ownership/role/session, uncertainty, entities, duplicates, ordering, timeout, failures, cancellation, reconnect, barge-in, overflow, silence segmentation, echo suppression and closed gates. Live transports/providers are rejected; a network-fetch sentinel is untouched by offline processing.

The reproducible [latency artifact](PHASE3_OFFLINE_LATENCY.json) measures 100 immediate scripted-mock iterations: median/p95 STT 0.037/0.139 ms, translation 0.030/0.102 ms, TTS 0.030/0.091 ms, total processing 0.164/0.568 ms. These exclude speech capture, 300 ms segmentation silence, queue wait, network, inference, telephony and playback. They demonstrate local orchestration overhead only, not real translation latency.

## Phase 3 changed files

- Added `apps/realtime-server/src/telephonyAudioCodec.ts`, `sarvamPipelineAdapters.ts`, `independentTranslationPipeline.ts`, `phase3Pipeline.test.ts`.
- Extended `independentCallOrchestrator.ts`, `independentCallFeature.ts`, `independentCallIntegration.test.ts`.
- Extended `packages/translation/src/index.ts` for quantities/currency and token-prefix restoration.
- Added disabled mock flag to `.env.example`; actual `.env` was untouched.
- Added `scripts/phase3-offline-benchmark.ts`, `PHASE3_OFFLINE_LATENCY.json`, `PHASE3_REPORT.md`.

Pre-existing Phase 1/2 modifications and untracked files were preserved. No Phase 3 edit was made to the legacy direct bridge or live provider path.

## Exact blockers and Phase 4 plan

BLOCKED: real Plivo call-leg isolation/audibility proof; actual playback and interruption validation; safe original bypass; non-mock Sarvam contract/linguistic/entity/audio tests; actual v4 partial-stream compatibility; acoustic echo cancellation and speech-quality tuning; end-to-end provider latency. Production remains disabled regardless of environment values. There is no live translation transport in this new pipeline.

Phase 4 can proceed offline: add authenticated dashboard session/detail views showing roles, connection state, routing mode, queued counts, bounded stage timings, sanitized errors and four distinct gate states. Persist session/leg lifecycle, stream generations, routing decisions and aggregate latency with idempotent event IDs and migrations. Keep tokens/keys/audio out of dashboard and persistence by default; define any transcript retention explicitly. Add mocked dashboard-to-API-to-database tests, reconnect/hangup recovery, retention cleanup and role-based access. A later separately authorized provider experiment must establish real isolation and codec/interruption behavior before designing a production playback authorization flow.
