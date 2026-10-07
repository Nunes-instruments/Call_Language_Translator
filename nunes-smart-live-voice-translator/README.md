# NUNES Smart Live Voice Translator

Phase 1 starter for a zero-app Tamil ↔ Hindi realtime telephone translation bridge.

## First VS Code run
1. Install Node.js 22+ and VS Code.
2. Extract/open this folder in VS Code.
3. Copy `.env.example` to `.env` (do not paste real secrets into Git).
4. Run `npm install`.
5. Run `npm test`.
6. Run `npm run typecheck`.
7. Run `npm run dev`.
8. Open `http://localhost:3000` and `http://localhost:8787/health`.

## Current checkpoint
Implemented: monorepo, dashboard starter, realtime WebSocket service, shared call states, initial SmartLanguageRouter tests, Drizzle schema starter, telephony abstraction.

Not yet implemented: real Plivo streaming, STT/translation/TTS adapters, Neon migration execution, authentication, barge-in, echo prevention, provider fallback. These are deliberately the next checkpoints and are not represented as complete.
