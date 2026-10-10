import { createHash, randomUUID } from "node:crypto";
export interface DatabaseConnection {
  query<T = Record<string, unknown>>(text: string, parameters?: unknown[]): Promise<T[]>;
  transaction<T>(operation: (connection: DatabaseConnection) => Promise<T>): Promise<T>;
}
export type Actor = { role: "ADMIN" | "VIEWER"; name: string };
export type EmployeeInput = { name: string; phone: string; department: string; defaultLanguage: "ta" | "hi"; enabled: boolean; callingRole: "staff" | "supervisor"; availability: "unknown" | "available" | "busy" | "away" };
export type GlossaryInput = { sourceTerm: string; preferredTranslation: string; languageFrom: "ta" | "hi" | "en"; languageTo: "ta" | "hi"; category: "PRODUCT" | "MODEL" | "TERM" | "UNIT"; preserveExact: boolean; enabled: boolean };
export interface SessionSnapshot {
  sessionId: string; state: string; closeReason?: string; providerMode: string;
  customer: { requestUuid: string | null; callUuid: string | null; streamId: string | null; answered: boolean; socketConnected: boolean };
  staff: SessionSnapshot["customer"];
  offlineTranslation?: { queued: unknown; metrics: { lastError: string; prepared: number; overflow: number; timings: unknown[] } } | null;
}
export interface LegDetail { role: string; requestUuid: string | null; callUuid: string | null; streamId: string | null; status: string; socketConnected: boolean }
export interface EventDetail { eventType: string; createdAt: unknown; metadata: unknown }
export interface StreamDetail { streamId: string; role: string; active: boolean; firstSeen: unknown; stoppedAt: unknown | null }
export interface SessionDetail {
  id: string;
  status: string;
  providerMode: string;
  legs: LegDetail[];
  events: EventDetail[];
  streams: StreamDetail[];
  [key: string]: unknown;
}
export class StoreError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const identifier = (id: string) => { if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new StoreError(400, "INVALID_ID"); return id; };
const safeText = (value: unknown, max: number) => { if (typeof value !== "string" || value.trim().length > max || /[\x00-\x1f<>]/.test(value)) throw new StoreError(400, "INVALID_TEXT"); return value.trim(); };
function exactKeys(input: Record<string, unknown>, keys: string[]) { if (Object.keys(input).some(key => !keys.includes(key))) throw new StoreError(400, "UNKNOWN_FIELD"); }
export function employeeInput(value: unknown): EmployeeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError(400, "INVALID_EMPLOYEE"); const input = value as Record<string, unknown>;
  exactKeys(input, ["name","phone","department","defaultLanguage","enabled","callingRole","availability"]);
  const name = safeText(input.name, 150), phone = safeText(input.phone, 30).replace(/[ ()-]/g, "");
  if (!name || !/^\+[1-9]\d{6,14}$/.test(phone)) throw new StoreError(400, "INVALID_NAME_OR_E164_PHONE");
  const defaultLanguage = input.defaultLanguage ?? "ta", enabled = input.enabled ?? true, callingRole = input.callingRole ?? "staff", availability = input.availability ?? "unknown";
  if (!["ta","hi"].includes(String(defaultLanguage)) || typeof enabled !== "boolean" || !["staff","supervisor"].includes(String(callingRole)) || !["available","busy","away","unknown"].includes(String(availability))) throw new StoreError(400, "INVALID_EMPLOYEE_SETTING");
  return { name, phone, department: safeText(input.department ?? "", 100), defaultLanguage, enabled, callingRole, availability } as EmployeeInput;
}
export function glossaryInput(value: unknown): GlossaryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError(400, "INVALID_GLOSSARY"); const input = value as Record<string, unknown>;
  exactKeys(input, ["sourceTerm","preferredTranslation","languageFrom","languageTo","category","preserveExact","enabled"]);
  const sourceTerm = safeText(input.sourceTerm, 64), preferredTranslation = safeText(input.preferredTranslation ?? "", 200);
  if (!sourceTerm || /NUNESENTITY|[{}\[\]`]/i.test(sourceTerm + preferredTranslation) || !["ta","hi","en"].includes(String(input.languageFrom)) || !["ta","hi"].includes(String(input.languageTo)) || !["PRODUCT","MODEL","TERM","UNIT"].includes(String(input.category)) || typeof input.preserveExact !== "boolean" || typeof input.enabled !== "boolean") throw new StoreError(400, "INVALID_GLOSSARY_SETTING");
  if (!input.preserveExact && !preferredTranslation) throw new StoreError(400, "TRANSLATION_REQUIRED");
  return { sourceTerm, preferredTranslation, languageFrom: input.languageFrom, languageTo: input.languageTo, category: input.category, preserveExact: input.preserveExact, enabled: input.enabled } as GlossaryInput;
}
const employeeColumns = 'id,name,phone,department,default_language AS "defaultLanguage",enabled,calling_role AS "callingRole",availability';
const glossaryColumns = 'id::text AS id,source_term AS "sourceTerm",preferred_translation AS "preferredTranslation",language_from AS "languageFrom",language_to AS "languageTo",category,preserve_exact AS "preserveExact",enabled';
export class ManagementStore {
  constructor(readonly db: DatabaseConnection) {}
  async health() { await this.db.query("SELECT 1"); await this.db.query("SELECT 1 FROM schema_migrations WHERE version='0002_phase4_management.sql'").then(rows => { if (!rows.length) throw new Error("SCHEMA_NOT_READY"); }); }
  private async audit(db: DatabaseConnection, actor: Actor, action: string, entity: string, id: string) { await db.query("INSERT INTO audit_logs(action,entity_type,entity_id,actor_role,actor_name) VALUES($1,$2,$3,$4,$5)", [action,entity,id,actor.role,actor.name]); }
  async employees() { return this.db.query(`SELECT ${employeeColumns} FROM employees ORDER BY name,id LIMIT 500`); }
  async overview() { const rows = await this.db.query("SELECT count(*) FILTER(WHERE started_at>=date_trunc('day',now()))::int AS today,count(*) FILTER(WHERE ended_at IS NULL)::int AS active,count(*) FILTER(WHERE translated)::int AS translated,count(*) FILTER(WHERE status IN ('FAILED','RECOVERY_CLOSED'))::int AS interrupted FROM call_sessions"); return { metrics:rows[0],...(await this.history({limit:5})) }; }
  async saveEmployee(value: unknown, actor: Actor, id?: string) {
    const input = employeeInput(value); if (id) identifier(id);
    return this.db.transaction(async db => {
      const parameters = [input.name,input.phone,input.department,input.defaultLanguage,input.enabled,input.callingRole,input.availability];
      const rows = id ? await db.query(`UPDATE employees SET name=$1,phone=$2,department=$3,default_language=$4,enabled=$5,calling_role=$6,availability=$7,updated_at=now() WHERE id=$8 RETURNING ${employeeColumns}`, [...parameters,id]) : await db.query(`INSERT INTO employees(name,phone,department,default_language,enabled,calling_role,availability) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${employeeColumns}`, parameters);
      if (!rows[0]) throw new StoreError(404,"EMPLOYEE_NOT_FOUND"); await this.audit(db,actor,id ? "employee.updated" : "employee.created","employee",String(rows[0].id)); return rows[0];
    });
  }
  async deleteEmployee(id: string, actor: Actor) {
    identifier(id); return this.db.transaction(async db => { const rows = await db.query("DELETE FROM employees WHERE id=$1 RETURNING id",[id]); if (!rows.length) throw new StoreError(404,"EMPLOYEE_NOT_FOUND"); await this.audit(db,actor,"employee.deleted","employee",id); });
  }
  async glossary(search = "") { return this.db.query(`SELECT ${glossaryColumns} FROM translation_glossary WHERE source_term ILIKE $1 ORDER BY priority,id LIMIT 500`, [`%${safeText(search,100)}%`]); }
  async saveGlossary(value: unknown, actor: Actor, id?: string) {
    const input = glossaryInput(value); if (id && !/^\d{1,18}$/.test(id)) throw new StoreError(400,"INVALID_GLOSSARY_ID");
    return this.db.transaction(async db => {
      const parameters = [input.sourceTerm,input.preferredTranslation,input.languageFrom,input.languageTo,input.category,input.preserveExact,input.enabled];
      const rows = id ? await db.query(`UPDATE translation_glossary SET source_term=$1,preferred_translation=$2,language_from=$3,language_to=$4,category=$5,preserve_exact=$6,enabled=$7,updated_at=now() WHERE id=$8 RETURNING ${glossaryColumns}`, [...parameters,id]) : await db.query(`INSERT INTO translation_glossary(source_term,preferred_translation,language_from,language_to,category,preserve_exact,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${glossaryColumns}`,parameters);
      if (!rows[0]) throw new StoreError(404,"GLOSSARY_NOT_FOUND"); await this.audit(db,actor,id ? "glossary.updated" : "glossary.created","glossary",String(rows[0].id)); return rows[0];
    });
  }
  async deleteGlossary(id: string, actor: Actor) { if (!/^\d{1,18}$/.test(id)) throw new StoreError(400,"INVALID_GLOSSARY_ID"); await this.db.transaction(async db => { const rows = await db.query("DELETE FROM translation_glossary WHERE id=$1 RETURNING id",[id]); if (!rows.length) throw new StoreError(404,"GLOSSARY_NOT_FOUND"); await this.audit(db,actor,"glossary.deleted","glossary",id); }); }
  async importGlossary(value: unknown, actor: Actor) { if (!Array.isArray(value) || !value.length || value.length > 50) throw new StoreError(400,"IMPORT_LIMIT_50"); const entries = value.map(glossaryInput); return this.db.transaction(async db => { const child = new ManagementStore(db); for (const entry of entries) await child.saveGlossary(entry,actor); return { imported: entries.length }; }); }
  async settings() { const rows = await this.db.query<{ setting_key: string; setting_value: unknown }>("SELECT setting_key,setting_value FROM system_settings WHERE setting_key IN ('translation','retention')"); return Object.fromEntries(rows.map(row => [row.setting_key,row.setting_value])); }
  async saveSettings(kind: string, value: unknown, actor: Actor) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError(400,"INVALID_SETTINGS"); const input = value as Record<string, unknown>;
    if (kind === "translation") { exactKeys(input,["staffLanguage","customerDetection","hindiToTamil","tamilToHindi","codeMixed","preserveTerms","unknownFallback"]); if (input.staffLanguage !== "ta" || input.unknownFallback !== "hold" || ["customerDetection","hindiToTamil","tamilToHindi","codeMixed","preserveTerms"].some(key => typeof input[key] !== "boolean") || input.preserveTerms !== true) throw new StoreError(400,"UNSAFE_LANGUAGE_SETTING"); }
    else if (kind === "retention") { exactKeys(input,["callDays","auditDays","retainAudio","retainTranscripts"]); if (!Number.isInteger(input.callDays) || Number(input.callDays) < 1 || Number(input.callDays) > 365 || !Number.isInteger(input.auditDays) || Number(input.auditDays) < 30 || Number(input.auditDays) > 730 || input.retainAudio !== false || input.retainTranscripts !== false) throw new StoreError(400,"INVALID_RETENTION"); }
    else throw new StoreError(400,"UNKNOWN_SETTING");
    await this.db.transaction(async db => { await db.query("UPDATE system_settings SET setting_value=$1::jsonb,updated_at=now() WHERE setting_key=$2",[JSON.stringify(input),kind]); await this.audit(db,actor,"settings.updated","settings",kind); }); return input;
  }
  async history(options: { page?: number; limit?: number; search?: string; status?: string; mode?: string; live?: boolean } = {}) {
    const page = options.page ?? 1, limit = options.limit ?? 20;
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError(400,"INVALID_PAGINATION");
    const search = safeText(options.search ?? "",100), status = safeText(options.status ?? "",30), mode = safeText(options.mode ?? "",20);
    const where = "WHERE (cs.id::text ILIKE $1 OR coalesce(e.name,'') ILIKE $1) AND ($2='' OR cs.status=$2) AND ($3='' OR cs.provider_mode=$3) AND (NOT $4 OR cs.ended_at IS NULL)";
    const args = [`%${search}%`,status,mode,options.live ?? false];
    const count = await this.db.query<{ count: string }>(`SELECT count(*) FROM call_sessions cs LEFT JOIN employees e ON e.id=cs.employee_id ${where}`,args);
    const items = await this.db.query(`SELECT cs.id,cs.started_at AS "startedAt",cs.ended_at AS "endedAt",coalesce(e.name,'Unassigned') AS employee,cs.direction,cs.provider_mode AS "providerMode",cs.status,cs.mode,cs.staff_language AS "staffLanguage",cs.customer_language AS "customerLanguage",cs.translated,cs.close_reason AS "failureReason",cs.audio_isolation_verified AS "audioIsolationVerified",cs.production_translation_authorized AS "productionTranslationAuthorized",CASE WHEN cs.ended_at IS NULL THEN greatest(0,extract(epoch FROM(now()-cs.started_at))::int) ELSE cs.duration_seconds END AS "durationSeconds",cs.diagnostics FROM call_sessions cs LEFT JOIN employees e ON e.id=cs.employee_id ${where} ORDER BY cs.started_at DESC,cs.id LIMIT $5 OFFSET $6`,[...args,limit,(page-1)*limit]);
    return { items,total: Number(count[0].count),page,limit };
  }
  async detail(id: string): Promise<SessionDetail> { identifier(id); const session = await this.db.query<{ id: string; status: string; providerMode: string }>("SELECT id,status,provider_mode AS \"providerMode\" FROM call_sessions WHERE id=$1",[id]); if (!session.length) throw new StoreError(404,"SESSION_NOT_FOUND"); return { ...session[0], legs: await this.db.query<LegDetail>('SELECT role,request_uuid AS "requestUuid",call_uuid AS "callUuid",stream_id AS "streamId",status,socket_connected AS "socketConnected" FROM call_legs WHERE session_id=$1 ORDER BY role',[id]), events: await this.db.query<EventDetail>('SELECT event_type AS "eventType",created_at AS "createdAt",metadata FROM call_events WHERE call_session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[id]), streams: await this.db.query<StreamDetail>('SELECT stream_id AS "streamId",role,active,first_seen AS "firstSeen",stopped_at AS "stoppedAt" FROM stream_lifecycle WHERE session_id=$1 ORDER BY first_seen DESC LIMIT 100',[id]) }; }
  async auditHistory(page = 1) { if (!Number.isInteger(page) || page < 1 || page > 10000) throw new StoreError(400,"INVALID_PAGINATION"); return this.db.query('SELECT id::text AS id,action,entity_type AS "entityType",entity_id AS "entityId",actor_role AS "actorRole",actor_name AS "actorName",created_at AS "createdAt" FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $1',[(page-1)*50]); }
  async beginSession(id: string, staffNumber: string) { identifier(id); await this.db.query("INSERT INTO call_sessions(id,call_id,employee_id,direction,staff_language,mode,status,provider_mode) VALUES($1,$2,(SELECT id FROM employees WHERE phone=$3 AND enabled LIMIT 1),'OUTBOUND','ta','CONNECTING','CONNECTING','offline')",[id,`independent-${id}`,staffNumber]); }
  async snapshot(snapshot: SessionSnapshot, event = "state.changed", eventKey: string = randomUUID()) {
    identifier(snapshot.sessionId);
    const terminal = snapshot.state === "closed", diagnostics = snapshot.offlineTranslation ? { queues: snapshot.offlineTranslation.queued, error: snapshot.offlineTranslation.metrics.lastError, prepared: snapshot.offlineTranslation.metrics.prepared, overflow: snapshot.offlineTranslation.metrics.overflow, timings: snapshot.offlineTranslation.metrics.timings.slice(-1) } : {};
    await this.db.transaction(async db => {
      const rows = await db.query("SELECT id,status FROM call_sessions WHERE id=$1 FOR UPDATE",[snapshot.sessionId]); if (!rows.length) throw new StoreError(404,"SESSION_NOT_FOUND");
      if (["COMPLETED","FAILED","RECOVERY_CLOSED"].includes(String(rows[0].status)) && !terminal) throw new StoreError(409,"SESSION_TERMINAL");
      await db.query("UPDATE call_sessions SET status=$1,mode=$2,close_reason=$3,diagnostics=$4::jsonb,ended_at=CASE WHEN $5 THEN coalesce(ended_at,now()) ELSE ended_at END,duration_seconds=CASE WHEN $5 THEN greatest(0,extract(epoch FROM(coalesce(ended_at,now())-started_at))::int) ELSE duration_seconds END,updated_at=now() WHERE id=$6",[terminal ? "COMPLETED" : snapshot.state.toUpperCase(),terminal ? "COMPLETED" : "TEMPORARY_UNCERTAIN",snapshot.closeReason ?? null,JSON.stringify(diagnostics),terminal,snapshot.sessionId]);
      for (const role of ["customer","staff"] as const) {
        const leg = snapshot[role];
        await db.query("INSERT INTO call_legs(session_id,role,request_uuid,call_uuid,stream_id,status,socket_connected) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id,role) DO UPDATE SET request_uuid=coalesce(call_legs.request_uuid,excluded.request_uuid),call_uuid=coalesce(call_legs.call_uuid,excluded.call_uuid),stream_id=excluded.stream_id,status=excluded.status,socket_connected=excluded.socket_connected,updated_at=now()",[snapshot.sessionId,role,leg.requestUuid,leg.callUuid,leg.streamId,terminal ? "closed" : leg.socketConnected ? "streaming" : leg.answered ? "answered" : "pending",!terminal && leg.socketConnected]);
        const previous = await db.query("SELECT request_uuid,call_uuid FROM call_legs WHERE session_id=$1 AND role=$2",[snapshot.sessionId,role]);
        if ((leg.requestUuid && previous[0].request_uuid !== leg.requestUuid) || (leg.callUuid && previous[0].call_uuid !== leg.callUuid)) throw new StoreError(409,"OWNERSHIP_CONFLICT");
        await db.query("UPDATE stream_lifecycle SET active=false,stopped_at=coalesce(stopped_at,now()) WHERE session_id=$1 AND role=$2 AND (stream_id IS DISTINCT FROM $3 OR $4)",[snapshot.sessionId,role,leg.streamId,terminal]);
        if (leg.streamId) {
          await db.query("INSERT INTO stream_lifecycle(stream_id,session_id,role,active) VALUES($1,$2,$3,$4) ON CONFLICT(stream_id) DO NOTHING",[leg.streamId,snapshot.sessionId,role,!terminal && leg.socketConnected]);
          const owners = await db.query("SELECT session_id,role,stopped_at FROM stream_lifecycle WHERE stream_id=$1",[leg.streamId]);
          if (owners[0].session_id !== snapshot.sessionId || owners[0].role !== role || (!terminal && leg.socketConnected && owners[0].stopped_at)) throw new StoreError(409,"STREAM_OWNERSHIP_CONFLICT");
          await db.query("UPDATE stream_lifecycle SET active=$1 WHERE stream_id=$2",[!terminal && leg.socketConnected,leg.streamId]);
        }
      }
      await db.query("INSERT INTO call_events(call_session_id,event_type,event_key,provider,metadata) VALUES($1,$2,$3,'plivo',$4::jsonb) ON CONFLICT(call_session_id,event_key) WHERE event_key IS NOT NULL DO NOTHING",[snapshot.sessionId,event,eventKey,JSON.stringify({ state: snapshot.state, providerMode: snapshot.providerMode })]);
    });
  }
  async callbackClaim(sessionId: string, nonce: string, digest: string) {
    const hash = createHash("sha256").update(nonce).digest("hex");
    return this.db.transaction(async db => { const inserted = await db.query("INSERT INTO callback_receipts(nonce_hash,session_id,digest,state) VALUES($1,$2,$3,'claimed') ON CONFLICT(nonce_hash) DO NOTHING RETURNING nonce_hash",[hash,sessionId,digest]); if (!inserted.length) throw new StoreError(409,"DURABLE_REPLAY_REJECTED"); return hash; });
  }
  async callbackComplete(hash: string) { await this.db.query("UPDATE callback_receipts SET state='complete' WHERE nonce_hash=$1 AND state='claimed'",[hash]); }
  async recover() {
    return this.db.transaction(async db => { const interrupted = await db.query<{ id: string }>("UPDATE call_sessions SET status='RECOVERY_CLOSED',mode='FAILED',close_reason='restart-recovery',ended_at=now(),duration_seconds=greatest(0,extract(epoch FROM(now()-started_at))::int),updated_at=now() WHERE provider_mode='offline' AND ended_at IS NULL RETURNING id"); for (const row of interrupted) { await db.query("UPDATE call_legs SET socket_connected=false,status='closed' WHERE session_id=$1",[row.id]); await db.query("UPDATE stream_lifecycle SET active=false,stopped_at=coalesce(stopped_at,now()) WHERE session_id=$1",[row.id]); await db.query("INSERT INTO call_events(call_session_id,event_type,event_key) VALUES($1,'restart.recovery',$2) ON CONFLICT(call_session_id,event_key) WHERE event_key IS NOT NULL DO NOTHING",[row.id,`restart-${row.id}`]); } return interrupted.length; });
  }
  async cleanup(actor: Actor) {
    const settings = await this.settings(), retention = settings.retention as { callDays: number; auditDays: number };
    return this.db.transaction(async db => { const calls = await db.query("DELETE FROM call_sessions WHERE provider_mode='offline' AND ended_at < now()-($1 * interval '1 day') RETURNING id",[retention.callDays]); await db.query("DELETE FROM audit_logs WHERE created_at < now()-($1 * interval '1 day')",[retention.auditDays]); await this.audit(db,actor,"retention.cleanup","settings","retention"); return { deletedCalls: calls.length }; });
  }
}
