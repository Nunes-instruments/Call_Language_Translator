# NUNES Smart Live Voice Translator
## Two-Leg Media Architecture — Offline Design

Status: DESIGN ONLY
Live translation: DISABLED
Production integration: NOT AUTHORIZED

### 1. Customer Leg
- Customer calls Plivo number.
- Customer media must be isolated from staff media.
- Customer inbound audio is captured separately.
- Customer playback must use the customer leg only.

### 2. Staff Leg
- Staff language defaults to Tamil.
- Staff call must have its own independently controlled media leg.
- Staff inbound audio is captured separately.
- Staff playback must use the staff leg only.

### 3. Tamil to Tamil
- Preserve natural two-way conversation.
- Do not translate.
- Do not generate replacement speech.
- Direct audio bypass requires a verified safe routing path.

### 4. Hindi to Tamil
- Recognize customer Hindi/Hinglish.
- Translate to Tamil.
- Generate Tamil speech for staff.
- Do not expose untranslated customer audio to staff.

### 5. Tamil to Hindi
- Recognize staff Tamil/Tanglish.
- Translate to Hindi.
- Generate Hindi speech for customer.
- Do not expose untranslated staff audio to customer.

### 6. Safety Requirements
- Verify customer leg isolation.
- Verify staff leg isolation.
- Verify original audio is not cross-bridged.
- Verify customer playback.
- Verify staff playback.
- Verify disconnect cleanup.
- Prevent stale socket disconnects from affecting new sockets.
- Never enable translation from environment variables alone.

### 7. Existing Production Limitation
Current /plivo/inbound uses Dial.
Dial bridges original customer and staff audio.
Existing TTS sends playAudio to the same WebSocket.
This does not prove safe cross-leg translated playback.

### 8. Activation Gate
Production activation remains forbidden until:
1. Real Plivo media isolation is demonstrated.
2. Both phone legs are tested independently.
3. Original audio leakage is ruled out.
4. Both translated playback directions are verified.
5. Tamil-to-Tamil bypass is verified.
6. Disconnect and reconnect safety tests pass.

### 9. Next Engineering Phase
Build offline lifecycle and media-routing contracts.
Use mocks for tests.
Do not modify production routes until real isolation evidence exists.
Do not initiate real phone calls during offline tests.
