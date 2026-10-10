# Phase 1 review — 9 October 2026

## 1. Existing implementation status — PASS (inspection), BLOCKED (production readiness)

- Branch: `feature/realtime-stt-language-router`. Installed Plivo SDK: `4.79.0`.
- Initial working tree contained an edited `apps/realtime-server/src/index.ts` and five untracked implementation files. These were preserved; the existing independent routes and signed callback controller were amended in place.
- Inspected the entry point, installed SDK validator, webhook guards, independent manager/session engine/controller, call creator, URL/XML builders, audio coordination/isolation modules, Sarvam integration, workspace scripts, and regression suites.
- `/plivo/inbound` still returns the original direct `<Dial>` bridge. The independent route registrar is not registered by `index.ts`, and the independent manager has no production session-creation orchestration.
- Sarvam streaming STT, Hindi-to-Tamil translation, Tamil TTS, entity protection, language routing, and database/dashboard code exist. Google STT also starts as a benchmark for accepted legacy streams. This is not a complete two-way isolated call translation implementation.
- The existing isolation assessment continues to return `audioIsolationVerified=false`. Live translation and TTS now consult that gate. No environment values or credentials were read or changed.

## 2. Bugs identified — PASS (confirmed fixes), BLOCKED (live provider verification)

1. **Incorrect signature parameter source:** independent routes merged URL query with POST form fields, although the SDK already includes query fields from the URL. GET query values could also be counted twice. Routes now supply the full external URL and only POST form fields to the SDK; GET supplies no additional parameter map.
2. **Incomplete live callback URL:** existing live handlers used a configured path without the incoming query string. Verification now preserves the request target under the configured HTTPS origin. Absolute targets, alternate origins, backslashes, fragments, and wrong paths are rejected. Host and forwarded headers are ignored.
3. **Custom identity assumptions:** session ID and role belong to the generated signed URL query; they are not assumed to appear in Plivo's POST body. Provider call identity comes from the method-specific provider parameter source.
4. **Incorrect stream field / missing binding:** Plivo documents `StreamID`, not `streamId`, for status callbacks. Stream start/stop now bind that authenticated field to the requested stream, and reject a call UUID that differs from the registered leg. Existing engine ownership checks continue to prevent UUID/stream reuse across sessions and roles.
5. **Ambiguous parameters / inconsistent GET consumption:** application parameter arrays are rejected, POST query/body collisions are rejected by independent routes, and live GET callback handlers consume verified query values instead of an empty/unverified body.
6. **Unauthenticated legacy WebSocket:** upgrade now requires SDK V3 verification against the configured external HTTPS URL. Independent session/role attachments are rejected on the legacy route. Stream start requires a known nonterminal database call; malformed, repeated, concurrent, unknown-call and database-error starts fail closed before STT setup.
7. **Unwired audio safety gate:** the legacy translation and TTS paths did not consult the existing false isolation gate. They now do; the database `translated` flag also remains false while isolation is unverified. Direct calling XML remains unchanged.

The original seven real-SDK cryptographic tests and five parameter-signature tests already passed at the baseline. STEP 137's reported failure is not reproducible in this checkout. The SDK implementation requires sorted decoded query key/value pairs; POST adds sorted name/value pairs, with `?` and the query/body separator handled exactly as installed SDK code dictates, then appends `.` and the nonce before HMAC-SHA256/base64. The new independent fixture generator covers GET/POST URLs with query strings and duplicate query values. No nonexistent SDK signature-generation export was introduced.

Provider references: [V3 signature validation](https://www.plivo.com/docs/voice/concepts/signature-validation), [stream status callback fields and WebSocket V3 headers](https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/audio-streaming-guide). The installed SDK is the authority for the offline canonicalization fixtures.

## 3. Files changed — PASS

- `apps/realtime-server/src/index.ts`: full signed callback URLs, strict method-specific parameters, GET handler consumption, legacy upgrade/start authentication, translation/TTS safety gate and translated metadata.
- `apps/realtime-server/src/independentCallRoutes.ts`: amended pre-existing untracked file; separates signed query identity from POST provider fields and uses `StreamID`.
- `apps/realtime-server/src/signedIndependentCallCallbacks.ts`: amended pre-existing untracked file; binds signed URL identity, call ownership and stream identity.
- `apps/realtime-server/src/plivoCallbackRequest.ts`: shared request URL/parameter boundary and legacy stream guards.
- `apps/realtime-server/src/plivoCallbackSecurity.test.ts`: nine focused offline regressions with actual SDK verification and Fastify injection.
- `PHASE1_REPORT.md`: this report.

The other initial untracked files remain untouched. TypeScript's generated dashboard build-info change was restored to its initial clean version after validation.

## 4. TypeScript results — PASS

`npm.cmd run typecheck` completed successfully across all workspace typecheck scripts. PowerShell blocks the `npm.ps1` shim under its current execution policy, so the installed `npm.cmd` shim was used without changing execution policy.

## 5. Offline test results — PASS

`npm.cmd test`: **229 tests passed in 35 test files**:

- Realtime server: 199 tests / 33 files (baseline: 190 / 32).
- Language router: 26 tests / 1 file.
- Translation entity protection: 4 tests / 1 file.

New regressions exercise GET/POST canonicalization, modified paths/query/body, duplicate query values, duplicate application identities, trusted-origin reconstruction despite malicious headers, valid provider POST forms, `StreamID` casing, wrong-call stream stop, cross-session call ownership, missing signatures, method-specific parameter consumption, WebSocket upgrade rejection, and malformed/concurrent/repeated/unknown stream starts. Existing isolation-gate tests also pass.

`git diff --check` passed. No real Plivo calls, Sarvam requests, server startup against the database, deployment, push, or commit were performed. These results establish offline behavior, not live telephony/media correctness.

## 6. Remaining blockers — BLOCKED

- Actual Plivo callback and WebSocket-upgrade signatures have not been observed after these changes. Trusted external origin must match the URL configured in Plivo; the same SDK-based HTTPS upgrade reconstruction needs controlled provider verification behind the actual proxy.
- Independent answer handlers currently return `OK`, not media XML. Independent XML has no configured stream lifecycle status callback. Separate start/stop endpoints do not constitute a complete provider event dispatcher.
- No authenticated orchestration binds an outbound create response / request UUID to the expected session and leg before the answer callback. Current ownership checks protect already-attached identities; complete initial provider ownership needs Phase 2 correlation.
- Nonce freshness/replay storage, reconnect generations, lifecycle event ordering, durable session ownership and restart behavior require a designed lifecycle contract. Legacy stream authentication plus known-call checking is not full independent session/leg/stream binding.
- Customer/staff audio isolation, original-audio bypass switching, cross-leg playback targeting, barge-in, echo suppression and two-leg cleanup are not verified on actual calls.
- Tamil/Tanglish-to-Hindi translation and Hindi playback are not wired into an isolated staff leg. Sarvam codec/model/API compatibility and language/entity fidelity require explicitly authorized provider tests.
- Dashboard/database integration was preserved in code; no live database or dashboard end-to-end test was run.

Production readiness remains BLOCKED.

## 7. Exact Phase 2 implementation plan — PASS (plan), BLOCKED (live activation)

1. Define and test the independent lifecycle contract offline: expected provider request/call UUID per session and role, signed callback URL identity, event types, idempotency, replay handling, call completion, stream reconnect generations, and durable ownership records.
2. Complete the existing answer and stream lifecycle routes: return independent media XML from authenticated answers, configure the provider's documented stream status callback URL/method, dispatch actual event fields, and correlate outbound creation responses before accepting call ownership. Register only through an explicitly enabled isolated test path.
3. Add a dedicated authenticated independent WebSocket path. Bind the signed upgrade identity and provider start message to the expected session/leg/call/stream generation. Preserve legacy bridge behavior; reject mismatches and stale connections before any provider setup.
4. Implement both Sarvam directions using the existing language router and entity-protection package: Hindi/Hinglish to Tamil for staff and Tamil/Tanglish to Hindi for customer. Add mocked provider regressions for numbers, measurements, models, uncertain language, codec/sample-rate compatibility, timeouts and failed entity restoration.
5. Build and test isolated media routing offline: only the opposite leg receives translated audio; Tamil-to-Tamil uses the controlled original-audio path; translation and direct original-audio routing cannot be active together. Test interruption, queued playback cancellation, echo suppression, stale socket rejection and teardown.
6. Integrate lifecycle and routing events with the existing database/dashboard. Test using isolated fixtures, including restart recovery, terminal calls, provider failures and truthful translation status.
7. After explicit approval for billable provider testing, run controlled two-leg calls with captured callback/upgrade diagnostics. Verify each leg hears only its intended source, codec/playback correctness, both translation directions, Tamil bypass, latency, disconnect cleanup and reconnect behavior. Record every required isolation-evidence field.
8. Only after actual calling and media-isolation tests pass, propose a concrete activation/deployment change for separate approval. Retain the false isolation gate until that approved change; do not activate translation on the existing direct bridge.
