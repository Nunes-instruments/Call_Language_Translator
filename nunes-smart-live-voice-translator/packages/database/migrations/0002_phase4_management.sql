ALTER TABLE employees ADD COLUMN IF NOT EXISTS department varchar(100) NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS calling_role varchar(20) NOT NULL DEFAULT 'staff' CHECK (calling_role IN ('staff','supervisor'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS availability varchar(20) NOT NULL DEFAULT 'unknown' CHECK (availability IN ('available','busy','away','unknown'));
CREATE UNIQUE INDEX IF NOT EXISTS employees_normalized_phone_unique ON employees(phone) WHERE phone IS NOT NULL;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS provider_mode varchar(20) NOT NULL DEFAULT 'legacy' CHECK (provider_mode IN ('legacy','offline','provider'));
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS close_reason varchar(80);
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS audio_isolation_verified boolean NOT NULL DEFAULT false CHECK (audio_isolation_verified = false);
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS production_translation_authorized boolean NOT NULL DEFAULT false CHECK (production_translation_authorized = false);
CREATE TABLE call_legs (
  session_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  role varchar(10) NOT NULL CHECK (role IN ('customer','staff')),
  request_uuid varchar(128) UNIQUE,
  call_uuid varchar(128) UNIQUE,
  stream_id varchar(128),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','streaming','disconnected','closed')),
  socket_connected boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, role)
);
CREATE TABLE stream_lifecycle (
  stream_id varchar(128) PRIMARY KEY,
  session_id uuid NOT NULL,
  role varchar(10) NOT NULL,
  active boolean NOT NULL DEFAULT false,
  first_seen timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  FOREIGN KEY(session_id,role) REFERENCES call_legs(session_id,role) ON DELETE CASCADE
);
CREATE UNIQUE INDEX stream_one_active_per_leg ON stream_lifecycle(session_id,role) WHERE active;
CREATE TABLE callback_receipts (
  nonce_hash char(64) PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  digest char(64) NOT NULL,
  state varchar(10) NOT NULL CHECK (state IN ('claimed','complete')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS event_key varchar(150);
CREATE UNIQUE INDEX call_event_idempotency ON call_events(call_session_id,event_key) WHERE event_key IS NOT NULL;
CREATE INDEX call_history_filters ON call_sessions(provider_mode,status,started_at DESC,id);
CREATE INDEX call_legs_owner ON call_legs(session_id,role,status);
CREATE INDEX callback_receipts_retention ON callback_receipts(created_at);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_role varchar(10) NOT NULL DEFAULT 'ADMIN';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name varchar(40) NOT NULL DEFAULT 'shared-admin';
CREATE INDEX audit_history_created ON audit_logs(created_at DESC,id);
INSERT INTO system_settings(setting_key,setting_value) VALUES
 ('translation', '{"staffLanguage":"ta","customerDetection":true,"hindiToTamil":true,"tamilToHindi":true,"codeMixed":true,"preserveTerms":true,"unknownFallback":"hold"}'),
 ('retention', '{"callDays":30,"auditDays":90,"retainAudio":false,"retainTranscripts":false}')
 ON CONFLICT(setting_key) DO NOTHING;
