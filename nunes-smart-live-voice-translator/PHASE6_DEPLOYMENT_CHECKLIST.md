# PHASE 6: DEPLOYMENT READINESS CHECKLIST
## Production & Staging Telephony Deployment Verification

**Document Version**: 1.0.0  
**Target Environment**: Staging / Production Staged Deployment  
**Safety Status**: Offline Ready | Pre-Deployment Gates Locked

---

## 1. Environment Variable Configuration Audit

Verify the presence and validity of all required environment variables in the host environment without logging or exposing raw secret values:

| Variable Name | Purpose | Presence in Local `.env` | Production Requirement |
| :--- | :--- | :---: | :--- |
| `DATABASE_URL` | Neon/PostgreSQL pooled connection string | **PRESENT** | Valid pooled PostgreSQL URL with `sslmode=require` |
| `DATABASE_URL_UNPOOLED` | Neon direct connection string (migrations) | Configured in Staging | Valid direct PostgreSQL URL for DDL migrations |
| `PLIVO_AUTH_ID` | Plivo Account Auth ID | **PRESENT** | Registered Plivo account ID |
| `PLIVO_AUTH_TOKEN` | Plivo Webhook & REST secret token | **PRESENT** | Used for HMAC signature verification |
| `PLIVO_NUMBER` | Plivo registered phone number | **PRESENT** | E.164 formatted registered Plivo number |
| `STAFF_PHONE_NUMBER` | Default Nunes staff phone number | **PRESENT** | E.164 formatted registered staff number |
| `SARVAM_API_KEY` | Sarvam AI API subscription key | **PRESENT** | Valid subscription for STT, translation, and TTS |
| `PUBLIC_BASE_URL` | Public HTTPS ingress domain | **PRESENT** | Public HTTPS domain (e.g. `https://live.nunes.example`) |
| `PORT` | Realtime server HTTP/WS listening port | **PRESENT** | Defaults to `8787` |
| `AUTH_SECRET` | Next.js dashboard session secret | **PRESENT** | 32+ character high-entropy secret |
| `NUNES_ADMIN_PASSWORD` | Management API administrator password | Set in Environment | High-entropy password for pilot control |
| `NUNES_VIEWER_PASSWORD` | Read-only dashboard viewer password | Set in Environment | Viewer access password |
| `NUNES_INDEPENDENT_CALLS_ENABLED` | Feature flag for independent two-leg calls | `false` (Default Safe) | Set `true` only during authorized pilot |
| `NUNES_INDEPENDENT_CALLS_TEST_MODE`| Provider test simulation flag | `true` (Staging) | Set `false` only during authorized pilot |
| `NUNES_MANAGEMENT_ENABLED` | Enables `/management/*` API routes | `true` (Staging) | Enable for pilot observability |

---

## 2. Infrastructure & Network Readiness

### 2.1 Public Ingress & SSL/TLS
- [ ] **Public Domain Configured**: `PUBLIC_BASE_URL` matches the external domain pointing to the server.
- [ ] **Valid SSL Certificate**: Trusted certificate from Let's Encrypt / Cloudflare; TLS 1.3 / 1.2 enabled.
- [ ] **WebSocket Upgrade Support**: Reverse proxy (Nginx, Caddy, or Cloudflare) configured to forward `Upgrade: websocket` headers to port `8787` without buffering.
- [ ] **Network Timeout Settings**: Proxy WebSocket idle timeout configured to at least 300 seconds to prevent carrier dropouts during quiet pauses.

### 2.2 Database & Migration Verification
- [ ] **Database Reachability**: Neon PostgreSQL instance responds to TCP ping with SSL required.
- [ ] **Schema Versioning**: Migrations `0001_existing_schema.sql` and `0002_phase4_management.sql` verified.
- [ ] **Table Integrity**: Tables `call_sessions`, `call_events`, `employees`, `technical_glossary`, and `audit_logs` exist with proper primary and foreign keys.
- [ ] **Safety Constraint Enforced**: Check constraint `CHECK (audio_isolation_verified = false)` verified active in database schema.

### 2.3 Application Daemons & Process Management
- [ ] **Realtime Fastify Server**: Deployed and supervised via PM2 or systemd (`apps/realtime-server`).
- [ ] **Next.js Dashboard**: Production build deployed (`apps/dashboard/.next`).
- [ ] **Healthcheck Endpoints**:
  - `GET /health` on Realtime Server returns `{ "status": "ok" }`.
  - `GET /api/health` on Dashboard returns `{ "status": "ok" }`.
- [ ] **Graceful Shutdown**: SIGTERM and SIGINT handlers verified to terminate active WebSocket streams cleanly.

---

## 3. Plivo Telephony Console Configuration

1. Log into [Plivo Console](https://console.plivo.com) → **Phone Numbers** → Select `PLIVO_NUMBER`.
2. Under **Application Configuration**:
   - **Primary Answer URL**: Set to `https://{domain}/plivo/inbound` (Method: `POST`).
   - **Fallback URL**: Set to fallback error handler if primary fails.
   - **Hangup URL**: Set to `https://{domain}/plivo/dial-status` (Method: `POST`).
3. For Independent-Leg Pilot Calls:
   - Dynamic answer URLs are generated programmatically with signed cryptographic nonces pointing to `/plivo/independent/answer`.

---

## 4. Pre-Flight Deployment Sanity Run

Before authorizing external traffic:

1. **Run Full Test Suite**:
   ```powershell
   npm.cmd test --workspaces --if-present
   ```
   **Verification**: All 378 tests must pass (0 failures).
2. **Run Workspace Typecheck**:
   ```powershell
   npm.cmd run typecheck --workspaces --if-present
   ```
   **Verification**: 0 TypeScript errors across all workspaces.
3. **Run Production Dashboard Build**:
   ```powershell
   npm.cmd --workspace apps/dashboard run build
   ```
   **Verification**: Next.js optimized build completes with 7 static/dynamic routes.
4. **Safety Locks Intact**:
   - `audioIsolationVerified` is `false`.
   - `productionTranslationAuthorized` is `false`.
   - Live translation playback gate remains closed.

---

## 5. Deployment Authorization Sign-Off

| Milestone | Requirement | Status | Sign-off |
| :--- | :--- | :---: | :--- |
| **Code Integrity** | Branch clean, tests pass, zero type errors | [x] PASS | Lead Engineer |
| **Environment Audit** | All required credentials present without exposure | [x] PASS | Security Lead |
| **Network & Ingress** | HTTPS and WSS endpoints verified reachable | [ ] PENDING PILOT | Operations |
| **Telephony Lock** | Safety locks engaged; no unverified live calls | [x] PASS | Lead Engineer |

