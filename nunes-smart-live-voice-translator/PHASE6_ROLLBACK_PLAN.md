# PHASE 6: EMERGENCY STOP & ROLLBACK PLAN
## Telephony Circuit Breaker, Incident Response & Service Recovery

**Document Version**: 1.0.0  
**Effective Scope**: All Staging, Field Pilot, and Production Environments  
**Objective**: Immediate, deterministic restoration of safe telephony operations within 60 seconds of any operational anomaly.

---

## 1. Rollback & Circuit Breaker Triggers

An immediate emergency stop and rollback is triggered if ANY of the following conditions occur:

| Priority | Trigger Condition | Detection Method | Action Required |
| :---: | :--- | :--- | :--- |
| **CRITICAL-1** | **Acoustic Media Leakage** | Operator detects biological voice of opposite party on either handset. | **Level 1 Immediate Telephony Kill** |
| **CRITICAL-2** | **Direct Bridge Fallback Attempt** | Any call leg executes `<Dial>` or `<Conference>` in independent-leg mode. | **Level 1 Immediate Telephony Kill** |
| **HIGH-3** | **Provider Service Degradation** | Sarvam AI or Plivo returns consecutive 5xx errors; STT/TTS latency exceeds 4,000ms. | **Level 2 Feature Disable** |
| **HIGH-4** | **Uncontrolled Call Duration** | Any test call exceeds 180 seconds without automatic disconnection. | **Level 1 Immediate Telephony Kill** |
| **MEDIUM-5** | **Database Connection Drop** | Neon/PostgreSQL disconnects and fails to reconnect within 10 seconds. | **Level 2 Feature Disable** |

---

## 2. Tiered Rollback Execution Procedures

### Level 1: Immediate In-Flight Telephony Kill (< 15 seconds)

If a live call is underway and must be halted immediately:

1. **Operator Physical Termination**:
   - Both operators press **End Call** on their mobile handsets.
2. **Management API Force-Kill**:
   - Issue termination request to realtime server:
     ```bash
     curl -X POST http://127.0.0.1:8787/internal/independent-calls/{sessionId}/terminate \
          -H "Authorization: Bearer <NUNES_ADMIN_PASSWORD>"
     ```
3. **Plivo Console Circuit Breaker**:
   - Log into [Plivo Console](https://console.plivo.com) → **Voice** → **Live Calls**.
   - Click **Hangup All** to instantly drop all active carrier legs.
4. **Server Process Hard Reset**:
   - If server becomes unresponsive, terminate the node process:
     ```powershell
     # Windows PowerShell
     Stop-Process -Name node -Force
     ```

---

### Level 2: Feature De-escalation & Environment Rollback (< 60 seconds)

To safely disable the independent-leg translation pipeline without disrupting incoming telephone inquiries:

1. **Disable Independent Calls in Environment**:
   Update `.env` configuration:
   ```ini
   # Disable independent call features
   NUNES_INDEPENDENT_CALLS_ENABLED=false
   NUNES_INDEPENDENT_CALLS_TEST_MODE=false
   NUNES_OFFLINE_TRANSLATION_ENABLED=false
   ```
2. **Restart Realtime Server**:
   ```powershell
   npm.cmd --workspace apps/realtime-server run dev
   ```
3. **Legacy Inbound Route Fallback**:
   - When `NUNES_INDEPENDENT_CALLS_ENABLED=false`, the server automatically directs standard incoming customer calls to the existing legacy `/plivo/inbound` handler.
   - The legacy handler executes the existing `<Response><Dial>` bridge directly connecting callers to `STAFF_PHONE_NUMBER`.
   - **Business Continuity Guarantee**: Customer phone inquiries continue to be answered by staff via normal direct telephony without translation interruption.

---

### Level 3: Database & Session Clean-up

To clean up hanging session state in the PostgreSQL database:

1. **Mark Active Sessions Terminated**:
   ```sql
   UPDATE call_sessions
   SET status = 'FAILED',
       error_reason = 'EMERGENCY_ROLLBACK',
       updated_at = NOW()
   WHERE status IN ('IN_PROGRESS', 'DETECTING_LANGUAGE', 'TRANSLATING');
   ```
2. **Verify Database Integrity**:
   - Verify that all active call locks are released.
   - Verify audit log recorded the `EMERGENCY_ROLLBACK` event.

---

## 3. Post-Rollback Diagnostics & Incident Review

Before attempting any subsequent test or re-enabling the feature:

1. **Log Analysis**:
   - Extract and archive server logs:
     ```powershell
     Get-Content logs/realtime-server.log | Select-String "ERROR|WARN|REJECTED|LEAK" > rollback-incident.log
     ```
2. **Plivo Call Detail Record (CDR) Audit**:
   - Download CDRs from Plivo Console for all calls during the incident window.
   - Confirm call duration, bill amount, hangup source (`caller`, `callee`, or `api`), and XML execution history.
3. **Sarvam AI Usage Audit**:
   - Inspect Sarvam dashboard API call logs to identify any unexpected request bursts or error spikes.
4. **Root Cause Analysis (RCA)**:
   - Identify whether failure was caused by network connectivity, provider timeout, carrier disconnect, or application state.
   - Fix must be verified offline via Vitest test suite (all 378 tests passing) before re-authorizing pilot.

---

## 4. Emergency Contact & Escalation Tree

| Role | Contact Mechanism | Action Responsibility |
| :--- | :--- | :--- |
| **Pilot Telephony Operator 1** | Mobile Device / Discord | In-flight handset hangup & acoustic verification |
| **Pilot Telephony Operator 2** | Mobile Device / Discord | In-flight handset hangup & acoustic verification |
| **Lead Telephony Engineer** | Primary Dev Terminal | API termination, Plivo console kill, server restart |
| **Database Administrator** | Neon Console / Terminal | Session state update, audit trail verification |

