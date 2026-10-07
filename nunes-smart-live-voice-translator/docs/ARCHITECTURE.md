# Architecture checkpoint 1
Phone ↔ Telephony Adapter ↔ Realtime Server ↔ SmartLanguageRouter ↔ (DIRECT_BYPASS OR STT → Translation → TTS) ↔ Telephony Adapter ↔ Phone.

Dashboard is operational/admin only. Realtime audio remains on a persistent WebSocket-capable service. Neon stores durable metadata/configuration, not latency-sensitive transient audio state.
