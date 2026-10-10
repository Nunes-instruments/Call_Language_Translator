# PHASE 6: LIVE-CALL PILOT TEST PLAN
## Controlled Field Telephony Execution & Safety Protocol

**Document Version**: 1.0.0  
**Target Execution Date**: Pre-Pilot Staging  
**Safety Status**: Dry-Run Authorized | Live Provider Calls Pending Explicit User Approval

---

## 1. Pilot Overview & Constraints

The purpose of this pilot is to validate the Nunes Smart Live Voice Translator under real carrier telephony conditions between two controlled handsets.

> [!IMPORTANT]
> **STRICT SAFETY ENFORCEMENT:**
> 1. No real calls will be initiated until this plan is reviewed and explicitly authorized by the project lead.
> 2. Calls are restricted exclusively to two registered, operator-owned mobile numbers.
> 3. Maximum call duration per test call is capped at **180 seconds (3 minutes)**.
> 4. Expected cost per 3-minute test call is negligible (< ₹10 / $0.15 across Plivo and Sarvam).
> 5. Emergency stop switches must be primed before dialing.

---

## 2. Infrastructure & Account Readiness Checklist

### 2.1 Authorized Telephony Handsets
- **Customer Handset Number (Phone A)**: E.164 verified test mobile (Operator Handset 1).
- **Staff Handset Number (Phone B)**: E.164 verified test mobile (Operator Handset 2).
- **Caller ID Number**: Verified Plivo rented number (`PLIVO_NUMBER` in `.env`).

### 2.2 Provider Credentials & Balances
- [ ] **Plivo Account Balance**: Minimum \$10 account balance confirmed on Plivo Console.
- [ ] **Plivo Auth ID & Token**: Configured in environment (`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`).
- [ ] **Sarvam AI Subscription**: Active subscription key configured (`SARVAM_API_KEY`).
  - STT Model: `saaras:v4`
  - Translation Model: `sarvam-translate:v1`
  - TTS Model: `bulbul:v3` (speaker: `shubh`)
- [ ] **PostgreSQL Database**: Neon serverless connection verified with applied migrations.

### 2.3 Public Network Ingress (HTTPS / WSS)
- [ ] **Public Base URL**: Fully qualified public domain configured (`PUBLIC_BASE_URL`), e.g., via Cloudflare Tunnel or ngrok.
- [ ] **SSL / TLS**: Valid HTTPS (port 443) and WSS (secure WebSockets) with trusted certificate.
- [ ] **Callback Routes**: Verified reachable externally:
  - `POST https://{domain}/plivo/independent/answer`
  - `POST https://{domain}/plivo/independent/hangup`
  - `POST https://{domain}/plivo/independent/stream-status`
  - `GET  wss://{domain}/plivo/independent/stream` (Upgrade)

---

## 3. Step-by-Step Pilot Execution Procedure

### Step 1: Pre-Flight Environment Sanity
1. Start server with independent call feature enabled for staging:
   ```bash
   # Example staging boot command
   npm.cmd --workspace apps/realtime-server run dev
   ```
2. Verify console logs indicate:
   - `INDEPENDENT CALL FEATURE REGISTERED`
   - `SMART LANGUAGE ROUTER INITIALIZED (STAFF: ta)`
   - `AUDIO ISOLATION VERIFICATION LOCK: ENGAGED`

### Step 2: Triggering Independent Call Creation
An authorized administrator issues the call initiation command via the management endpoint:
```http
POST /internal/independent-calls
Authorization: Bearer <NUNES_ADMIN_PASSWORD>
Content-Type: application/json

{
  "customerNumber": "+91XXXXXXXXXX",
  "staffNumber": "+91YYYYYYYYYY"
}
```
**Expected System Response**:
- HTTP 201 Created with `{ "sessionId": "uuid-...", "customer": { "requestUuid": "..." }, "staff": { "requestUuid": "..." } }`.
- Plivo initiates outbound calls to both Handset A and Handset B simultaneously.

### Step 3: Answering Call Legs
1. **Handset B (Staff)** rings: Operator answers.
   - Plivo requests `/plivo/independent/answer?sessionId={s}&role=staff`.
   - Server returns `<Stream>` pointing to `/plivo/independent/stream`.
   - Handset B connects to WebSocket stream.
2. **Handset A (Customer)** rings: Operator answers.
   - Plivo requests `/plivo/independent/answer?sessionId={s}&role=customer`.
   - Handset A connects to independent WebSocket stream.
3. Both handsets hear clean line connection (no audio yet).

### Step 4: Utterance 1 — Customer Hindi Inquiry
1. **Action**: Customer speaks:
   > *"नमस्ते, मुझे फ्लूक 754 प्रेशर कैलिब्रेटर का कोटेशन चाहिए"*  
   > *(Namaste, mujhe Fluke 754 pressure calibrator ka quotation chahiye)*
2. **Handset A (Customer) hears**: Complete silence / comfort noise (their own voice is not echoed back).
3. **Handset B (Staff) hears**:
   - Zero biological Hindi speech during customer speech.
   - After ~1.8 seconds: Synthetic Tamil speech (`bulbul:v3`):
   > *"வணக்கம், எனக்கு Fluke 754 பிரஷர் காலிபிரேட்டர் கொட்டேஷன் வேண்டும்"*  
   > *(Vanakkam, enakku Fluke 754 pressure calibrator quotation vendum)*
   - Note entity preservation: *"Fluke 754"* and *"pressure calibrator"* clearly pronounced.

### Step 5: Utterance 2 — Staff Tamil Reply
1. **Action**: Staff speaks:
   > *"வணக்கம் சார், எங்களிடம் Fluke 754 ஸ்டாக்கில் உள்ளது, விலை பன்னிரண்டாயிரத்து ஐந்நூறு ரூபாய்"*  
   > *(Vanakkam sir, engalidam Fluke 754 stock-il ulladhu, vilai 12,500 roobai)*
2. **Handset B (Staff) hears**: No echo.
3. **Handset A (Customer) hears**:
   - Zero biological Tamil speech during staff speech.
   - After ~1.8 seconds: Synthetic Hindi speech (`bulbul:v3`):
   > *"नमस्ते सर, हमारे पास Fluke 754 स्टॉक में उपलब्ध है, कीमत ₹12,500 है"*
   - Note entity preservation: *"₹12,500"* and *"Fluke 754"*.

### Step 6: Utterance 3 — Customer Code-Mixed Hinglish
1. **Action**: Customer speaks Hinglish:
   > *"Delivery time kitna hoga aur GST 18% included hai kya?"*
2. **System Behavior**:
   - `detectMixedLanguage` identifies Hinglish vocabulary (`kitna`, `hoga`, `hai`).
   - Normalizes to Hindi (`hi`).
   - Translates to Tamil preserving *"Delivery time"* and *"GST 18%"*.
3. **Handset B (Staff) hears**:
   > *"டெலிவரி நேரம் எவ்வளவு ஆகும் மற்றும் GST 18% சேர்க்கப்பட்டுள்ளதா?"*

### Step 7: Utterance 4 — Barge-in Interrupt Test
1. Customer starts speaking a sentence.
2. While Staff translation audio is playing on Handset B, Staff starts speaking.
3. **Verification**:
   - Server VAD detects Staff speech.
   - Server issues `clearAudio` command to Handset B.
   - Handset B immediately silences synthetic speech within 250ms.

### Step 8: Clean Call Termination
1. Customer hangs up Handset A.
2. Server receives `/plivo/independent/hangup` callback with `Event: "Hangup"`.
3. Server terminates opposite leg on Handset B and cleans up session within 1000ms.
4. Database records `call_sessions` status as `COMPLETED`.

---

## 4. Emergency Stop Procedures

If any anomalous behavior occurs during the pilot:
1. **Operator Hangup**: Either operator immediately taps **End Call** on their mobile handset.
2. **Management API Force-Kill**:
   ```bash
   curl -X POST https://{domain}/management/calls/{sessionId}/terminate \
        -H "Authorization: Bearer <NUNES_ADMIN_PASSWORD>"
   ```
3. **Plivo Console Terminate**: In Plivo Console → Active Calls → Click **End Call**.
4. **Server Process Shutdown**: Press `Ctrl+C` on the realtime server terminal.

---

## 5. Expected Telephony & Provider Costs

| Item | Rate | Pilot Usage (3 calls x 2 legs x 3 min) | Estimated Total Cost |
| :--- | :--- | :--- | :--- |
| **Plivo Outbound India Mobile** | ~$0.016 / min | 18 call minutes | ~$0.29 (₹24.00) |
| **Sarvam STT (`saaras:v4`)** | ~$0.003 / min | 9 audio minutes | ~$0.03 (₹2.50) |
| **Sarvam Translation** | ~$0.0001 / 1k chars | ~3,000 characters | ~$0.01 (₹0.80) |
| **Sarvam TTS (`bulbul:v3`)** | ~$0.003 / 1k chars | ~3,000 characters | ~$0.01 (₹0.80) |
| **Total Estimated Pilot Cost** | — | — | **< $0.35 (₹30.00)** |

---

## 6. Pilot Sign-Off & Approval Requirement

| Role | Name | Approval Status | Signature / Date |
| :--- | :--- | :---: | :--- |
| **Lead Engineer** | Nunes Team | [ ] REVIEWED | _________________ |
| **Telephony Operations** | Pilot Operator | [ ] READY | _________________ |
| **Executive / Project Owner** | Project Owner | [ ] APPROVED | _________________ |

