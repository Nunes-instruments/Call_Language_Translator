# CONTROLLED PILOT OPERATOR GUIDE
## Step-by-Step Operator Manual for Staged Two-Phone Live Testing

**Document Version**: 1.0.0  
**Target Audience**: Test Telephony Operators & QA Engineers  
**Prerequisite**: Staging server running with admin access. Zero unverified calls permitted.

---

## 1. Pre-Flight Setup & Environment Preparation

### 1.1 Physical Equipment
- **Handset A (Customer Role)**: Operator 1 located in Room A (closed door).
- **Handset B (Staff Role)**: Operator 2 located in Room B (closed door, minimum 10m away).
- Direct-line or in-ear acoustic recording active on both handsets to verify audio playback.

### 1.2 Administrative Token & Allowlist Configuration
1. Obtain the `NUNES_ADMIN_PASSWORD` from your secure staging environment configuration.
2. Configure the two authorized test phone numbers via the management API:
   ```bash
   curl -X POST http://127.0.0.1:8787/management/pilot/allowlist \
     -H "Authorization: Bearer <NUNES_ADMIN_PASSWORD>" \
     -H "Content-Type: application/json" \
     -d '{
       "customerNumber": "+91XXXXXXXXXX",
       "staffNumber": "+91YYYYYYYYYY"
     }'
   ```
3. Verify status:
   ```bash
   curl -X GET http://127.0.0.1:8787/management/pilot/status \
     -H "Authorization: Bearer <NUNES_ADMIN_PASSWORD>"
   ```
   Confirm that `pilotReady: true`, `allowlistConfigured: true`, and `emergencyStopEngaged: false`.

---

## 2. Initiating a Controlled Pilot Session

To start an authorized test call:
```bash
curl -X POST http://127.0.0.1:8787/management/pilot/sessions \
  -H "Authorization: Bearer <NUNES_ADMIN_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{
    "customerNumber": "+91XXXXXXXXXX",
    "staffNumber": "+91YYYYYYYYYY",
    "operatorId": "operator-lead",
    "operatorConsent": true
  }'
```
**Safety Safeguards**:
- Rejects instantly if phone numbers do not match the allowlist (HTTP 403).
- Rejects if `operatorConsent` is false (HTTP 400).
- Automatically initializes a **180-second hard disconnect timer**.

**Handset Answering Sequence**:
1. Handset B (Staff) rings first → Operator 2 answers.
2. Handset A (Customer) rings next → Operator 1 answers.
3. Both operators confirm line connection. Both lines should be silent (no static, no audio bridge).

---

## 3. Test Scenarios & Scripted Dialogue

### Scenario 1: Customer Hindi → Staff Tamil
- **Speaker**: Operator 1 (Customer Phone).
- **Script**:
  > *"नमस्ते, मुझे फ्लूक 754 प्रेशर कैलिब्रेटर चाहिए"*  
  > *(Namaste, mujhe Fluke 754 pressure calibrator chahiye)*
- **Operator 1 (Customer) Verification**:
  - Hears complete silence while speaking. No feedback or echo.
- **Operator 2 (Staff) Verification**:
  - **Acoustic Leak Check**: Listens intently during seconds 0–1.2s. **Zero biological Hindi speech audible**.
  - **Translated Playback**: After ~1.8s, hears clear synthetic Tamil voice (`bulbul:v3`):
    > *"வணக்கம், எனக்கு Fluke 754 பிரஷர் காலிபிரேட்டர் வேண்டும்"*
- **Status Evaluation**: [ ] PASS / [ ] FAIL (Leak detected)

---

### Scenario 2: Staff Tamil → Customer Hindi
- **Speaker**: Operator 2 (Staff Phone).
- **Script**:
  > *"எங்களிடம் Fluke 754 ஸ்டாக்கில் உள்ளது, விலை பன்னிரண்டாயிரத்து ஐந்நூறு ரூபாய்"*  
  > *(Engalidam Fluke 754 stock-il ulladhu, vilai 12,500 roobai)*
- **Operator 2 (Staff) Verification**: Hears silence while speaking.
- **Operator 1 (Customer) Verification**:
  - **Acoustic Leak Check**: Listens during seconds 0–1.5s. **Zero biological Tamil speech audible**.
  - **Translated Playback**: After ~1.8s, hears clear synthetic Hindi voice (`bulbul:v3`):
    > *"हमारे पास Fluke 754 स्टॉक में उपलब्ध है, कीमत ₹12,500 है"*
- **Status Evaluation**: [ ] PASS / [ ] FAIL (Leak detected)

---

### Scenario 3: Code-Mixed Hinglish & Tanglish
- **Customer speaks Hinglish**:
  > *"Delivery time kitna hoga aur GST 18% included hai kya?"*
- **Staff hears translated Tamil**:
  > *"டெலிவரி நேரம் எவ்வளவு ஆகும் மற்றும் GST 18% சேர்க்கப்பட்டுள்ளதா?"*
- **Staff speaks Tanglish**:
  > *"Delivery seekiram pannidalam sir, bill GST oda varum"*
- **Customer hears translated Hindi**:
  > *"डिलीवरी जल्दी हो जाएगी सर, बिल GST के साथ आएगा"*
- **Status Evaluation**: [ ] PASS / [ ] FAIL

---

### Scenario 4: Technical Entity & Model Number Protection
- **Customer speaks complex calibration terms**:
  > *"DPI 620G model me 4 to 20 mA aur 100 psi range support karta hai?"*
- **Staff hears in Tamil**:
  > *"DPI 620G மாடலில் 4 to 20 mA மற்றும் 100 psi வரம்பு ஆதரிக்கப்படுகிறதா?"*
- **Verification**: `DPI 620G`, `4 to 20 mA`, `100 psi` preserved verbatim without phonetic distortion or translation into Tamil numerals.
- **Status Evaluation**: [ ] PASS / [ ] FAIL

---

### Scenario 5: Interruption & Barge-in Test
1. Operator 1 (Customer) speaks a long sentence.
2. While Staff Phone is receiving and playing the synthetic Tamil audio, Operator 2 (Staff) begins speaking: *"சரி சார்..."* (Sari sir...).
3. **Verification**:
   - Realtime server VAD detects Operator 2's voice.
   - Staff Phone immediately receives `clearAudio` command.
   - Playback ceases abruptly within 250ms, allowing Operator 2 to speak cleanly.
- **Status Evaluation**: [ ] PASS / [ ] FAIL

---

### Scenario 6: Call Disconnect & Recovery
1. Operator 1 taps **End Call** on Customer Handset.
2. **Verification**:
   - Realtime server receives hangup callback.
   - Operator 2's Staff Handset disconnects automatically within 1000ms.
   - Session status in API updates from `in-progress` to `terminated`.
- **Status Evaluation**: [ ] PASS / [ ] FAIL

---

## 4. Emergency Stop Procedures

If ANY acoustic voice leakage, unexpected carrier audio, or system instability is detected:

### Option A: API Emergency Stop (Recommended)
Issue the emergency kill command:
```bash
curl -X POST http://127.0.0.1:8787/management/pilot/emergency-stop \
  -H "Authorization: Bearer <NUNES_ADMIN_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Acoustic voice bleed suspected" }
```
**Outcome**:
- Instantly terminates all active pilot calls.
- Locks the pilot circuit breaker (`emergencyStopEngaged: true`).
- Rejects any subsequent session starts with HTTP 423 Locked.

### Option B: Physical Handset Hangup
Both operators immediately press **End Call** on their mobile phones.

---

## 5. Post-Test Debrief & Telemetry Logging

After completing the test session:
1. Inspect session telemetry:
   ```bash
   curl -X GET http://127.0.0.1:8787/management/pilot/sessions \
     -H "Authorization: Bearer <NUNES_ADMIN_PASSWORD>"
   ```
2. Confirm session duration was within the 180-second limit.
3. Review audio recordings from both handsets.
4. Record findings in [CONTROLLED_PILOT_TEST_RESULTS.md](file:///C:/Users/NUNES/Downloads/NUNES_SMART_LIVE_VOICE_TRANSLATOR_PHASE1/nunes-smart-live-voice-translator/CONTROLLED_PILOT_TEST_RESULTS.md).

