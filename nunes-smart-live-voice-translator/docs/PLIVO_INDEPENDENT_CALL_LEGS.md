# NUNES Smart Live Voice Translator
## Independent Plivo Call-Leg Design

Status: DESIGN ONLY
Production activation: BLOCKED

### Objective

Support:
- Tamil customer <-> Tamil staff: original speech, no translation
- Hindi customer -> Tamil staff: translated Tamil playback
- Tamil staff -> Hindi customer: translated Hindi playback

No external calling app is required for either participant.

### Call Architecture

Customer Phone
    |
    v
Plivo Customer Call Leg
    |
    v
Customer Inbound Media Stream
    |
    v
NUNES Media Coordinator
    |
    +--> Language Decision
    |
    +--> Translation Pipeline
    |
    v
Staff Outbound Media Stream
    |
    v
Plivo Staff Call Leg
    |
    v
Staff Phone

Reverse direction:

Staff Phone
    |
    v
Plivo Staff Call Leg
    |
    v
Staff Inbound Media Stream
    |
    v
NUNES Media Coordinator
    |
    +--> Tamil STT
    +--> Hindi Translation
    +--> Hindi TTS
    |
    v
Customer Outbound Media Stream
    |
    v
Customer Phone

### Mandatory Requirements

1. Customer and staff must have distinct call UUIDs.
2. Customer and staff must have distinct stream IDs.
3. Each WebSocket must belong to one verified call leg.
4. Never trust a caller-provided role without validation.
5. Verify Plivo webhook signatures.
6. Do not use Dial bridging during translated operation.
7. Never forward untranslated audio during translated operation.
8. Translation must remain disabled until isolation is proven.
9. A disconnected leg must not receive playback.
10. Stale WebSocket disconnects must not affect replacement sockets.
11. Complete both-leg cleanup when a call ends.
12. Avoid recording or exposing sensitive call content unnecessarily.

### Tamil-to-Tamil Bypass

A language decision of bypass does not itself create an audio path.

A verified direct-audio route must be implemented and tested
before declaring Tamil-to-Tamil phone calls operational.

### Plivo Validation

The offline XML prototype is not evidence that Plivo supports
the complete desired isolated two-phone architecture.

Verify with official provider documentation and controlled
test calls before changing production routing.

### Required Test Evidence

- Independent customer audio capture
- Independent staff audio capture
- No original audio leakage between translated legs
- Customer playback confirmation
- Staff playback confirmation
- Correct Tamil-to-Tamil bypass
- Correct Hindi-to-Tamil translation
- Correct Tamil-to-Hindi translation
- Call disconnect cleanup
- Webhook authentication
- Reconnect and stale-event safety

### Activation Policy

No production activation is authorized by this document.

Keep the existing translation safety gates in place.