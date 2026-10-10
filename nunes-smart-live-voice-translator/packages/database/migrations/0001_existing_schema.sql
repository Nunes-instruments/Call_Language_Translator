-- Existing schema only: no seed users, calls, provider settings or extension changes.
CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(150) NOT NULL,
        email VARCHAR(255) UNIQUE,
        role VARCHAR(30) NOT NULL DEFAULT 'STAFF'
          CHECK (role IN ('OWNER','ADMIN','STAFF')),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS employees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_code VARCHAR(50) UNIQUE,
        name VARCHAR(150) NOT NULL,
        phone VARCHAR(30),
        email VARCHAR(255),
        default_language VARCHAR(10) NOT NULL DEFAULT 'ta',
        language_locked BOOLEAN NOT NULL DEFAULT TRUE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS language_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        default_language VARCHAR(10) NOT NULL DEFAULT 'ta',
        language_locked BOOLEAN NOT NULL DEFAULT TRUE,
        confidence_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.850,
        switch_consecutive_count INTEGER NOT NULL DEFAULT 3,
        minimum_speech_ms INTEGER NOT NULL DEFAULT 800,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(employee_id)
      );

CREATE TABLE IF NOT EXISTS call_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        call_id VARCHAR(150) UNIQUE NOT NULL,
        provider_call_id VARCHAR(255),
        employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,

        direction VARCHAR(20)
          CHECK (direction IN ('INBOUND','OUTBOUND')),

        staff_language VARCHAR(10),
        customer_language VARCHAR(10),

        mode VARCHAR(40) NOT NULL DEFAULT 'WAITING'
          CHECK (
            mode IN (
              'WAITING',
              'CONNECTING',
              'DETECTING_LANGUAGE',
              'DIRECT_BYPASS',
              'TRANSLATION_ACTIVE',
              'TEMPORARY_UNCERTAIN',
              'RECONNECTING',
              'CALL_ENDING',
              'COMPLETED',
              'FAILED'
            )
          ),

        translated BOOLEAN NOT NULL DEFAULT FALSE,

        customer_number_masked VARCHAR(50),

        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        answered_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,

        duration_seconds INTEGER DEFAULT 0,
        average_latency_ms INTEGER,
        translation_failures INTEGER NOT NULL DEFAULT 0,

        telephony_provider VARCHAR(50) DEFAULT 'plivo',

        status VARCHAR(30) NOT NULL DEFAULT 'WAITING',

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS call_events (
        id BIGSERIAL PRIMARY KEY,
        call_session_id UUID NOT NULL
          REFERENCES call_sessions(id)
          ON DELETE CASCADE,

        event_type VARCHAR(80) NOT NULL,
        direction VARCHAR(30),
        provider VARCHAR(50),

        latency_ms INTEGER,

        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS call_transcripts (
        id BIGSERIAL PRIMARY KEY,

        call_session_id UUID NOT NULL
          REFERENCES call_sessions(id)
          ON DELETE CASCADE,

        speaker VARCHAR(30) NOT NULL,
        source_language VARCHAR(10),
        target_language VARCHAR(10),

        source_text TEXT,
        translated_text TEXT,

        stt_confidence NUMERIC(5,4),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS translation_glossary (
        id BIGSERIAL PRIMARY KEY,

        source_term TEXT NOT NULL,
        preferred_translation TEXT,

        language_from VARCHAR(10),
        language_to VARCHAR(10),

        category VARCHAR(40) NOT NULL DEFAULT 'CUSTOM',

        preserve_exact BOOLEAN NOT NULL DEFAULT FALSE,

        priority INTEGER NOT NULL DEFAULT 100,

        enabled BOOLEAN NOT NULL DEFAULT TRUE,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS provider_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        provider_type VARCHAR(30) NOT NULL,
        provider_name VARCHAR(80) NOT NULL,

        priority INTEGER NOT NULL DEFAULT 1,

        enabled BOOLEAN NOT NULL DEFAULT TRUE,

        config JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE(provider_type, provider_name)
      );

CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(150) PRIMARY KEY,
        setting_value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,

        user_id UUID REFERENCES users(id) ON DELETE SET NULL,

        action VARCHAR(150) NOT NULL,
        entity_type VARCHAR(100),
        entity_id VARCHAR(150),

        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_call_sessions_started_at
      ON call_sessions(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_sessions_employee
      ON call_sessions(employee_id);

CREATE INDEX IF NOT EXISTS idx_call_events_session
      ON call_events(call_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_transcripts_session
      ON call_transcripts(call_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_glossary_lookup
      ON translation_glossary(language_from, language_to, enabled);
