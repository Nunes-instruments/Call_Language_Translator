import Fastify from "fastify";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import postgres from "postgres";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

const PORT = Number(process.env.PORT || 8787);

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://remote-material-staple.ngrok-free.dev";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is missing from root .env");
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 5,
});

const app = Fastify({
  logger: true,
  trustProxy: true,
});

await app.register(formbody);
await app.register(websocket);

// ============================================================
// HELPERS
// ============================================================

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function maskPhone(phone?: string): string | null {
  if (!phone) return null;

  const clean = phone.trim();

  if (clean.length <= 4) {
    return "****";
  }

  return `${"*".repeat(Math.max(4, clean.length - 4))}${clean.slice(-4)}`;
}

function makeInternalCallId(providerCallId?: string): string {
  if (providerCallId) {
    return `plivo-${providerCallId}`;
  }

  return `plivo-${crypto.randomUUID()}`;
}

// ============================================================
// HEALTH
// ============================================================

app.get("/health", async () => {
  let database = "UNKNOWN";

  try {
    await sql`SELECT 1`;
    database = "CONNECTED";
  } catch {
    database = "DISCONNECTED";
  }

  return {
    service: "realtime-server",
    status: database === "CONNECTED" ? "HEALTHY" : "DEGRADED",
    database,
    timestamp: new Date().toISOString(),
  };
});

// ============================================================
// PLIVO INBOUND WEBHOOK
// ============================================================

app.all("/plivo/inbound", async (request, reply) => {
  try {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};

    const query =
      request.query && typeof request.query === "object"
        ? (request.query as Record<string, unknown>)
        : {};

    const getValue = (key: string): string | undefined => {
      const bodyValue = body[key];
      const queryValue = query[key];

      if (typeof bodyValue === "string" && bodyValue.trim()) {
        return bodyValue.trim();
      }

      if (typeof queryValue === "string" && queryValue.trim()) {
        return queryValue.trim();
      }

      return undefined;
    };

    const providerCallId =
      getValue("CallUUID") ||
      getValue("RequestUUID");

    const from =
      getValue("From") ||
      getValue("FromNumber");

    const to =
      getValue("To") ||
      getValue("ToNumber");

    const internalCallId = makeInternalCallId(providerCallId);

    // Sebastian / default Tamil staff
    const employees = await sql`
      SELECT id
      FROM employees
      WHERE employee_code = 'NUNES-001'
        AND enabled = TRUE
      LIMIT 1
    `;

    const employeeId = employees[0]?.id ?? null;

    // Idempotent insert
    await sql`
      INSERT INTO call_sessions (
        call_id,
        provider_call_id,
        employee_id,
        direction,
        staff_language,
        customer_language,
        mode,
        translated,
        customer_number_masked,
        telephony_provider,
        status
      )
      VALUES (
        ${internalCallId},
        ${providerCallId ?? null},
        ${employeeId},
        'INBOUND',
        'ta',
        NULL,
        'CONNECTING',
        FALSE,
        ${maskPhone(from)},
        'plivo',
        'CONNECTING'
      )
      ON CONFLICT (call_id)
      DO UPDATE SET
        provider_call_id = EXCLUDED.provider_call_id,
        updated_at = NOW()
    `;

    const sessions = await sql`
      SELECT id
      FROM call_sessions
      WHERE call_id = ${internalCallId}
      LIMIT 1
    `;

    const sessionId = sessions[0]?.id;

    if (sessionId) {
      await sql`
        INSERT INTO call_events (
          call_session_id,
          event_type,
          direction,
          provider,
          metadata
        )
        VALUES (
          ${sessionId},
          'PLIVO_INBOUND_WEBHOOK',
          'INBOUND',
          'plivo',
          ${sql.json({
            destinationPresent: Boolean(to),
            callerMasked: maskPhone(from),
          })}
        )
      `;
    }

    /*
      IMPORTANT:
      This step intentionally does NOT start AI translation yet.

      First we prove:

      Plivo
        -> webhook
        -> realtime server
        -> Neon session

      Next step adds bidirectional media streaming.
    */

    const websocketUrl =
      PUBLIC_BASE_URL
        .replace(/^https:/, "wss:")
        .replace(/^http:/, "ws:");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true"
          keepCallAlive="true"
          contentType="audio/x-mulaw;rate=8000"
          statusCallbackUrl="${escapeXml(`${PUBLIC_BASE_URL}/plivo/stream-status`)}"
          statusCallbackMethod="POST">${escapeXml(`${websocketUrl}/plivo/stream`)}</Stream>
</Response>`;

    reply
      .code(200)
      .header("Content-Type", "application/xml; charset=utf-8")
      .send(xml);

  } catch (error) {
    request.log.error(error);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak language="en-US">Temporary system error.</Speak>
</Response>`;

    reply
      .code(200)
      .header("Content-Type", "application/xml; charset=utf-8")
      .send(xml);
  }
});

// ============================================================
// PLIVO AUDIO STREAM
// ============================================================

app.get(
  "/plivo/stream",
  { websocket: true },
  (socket, request) => {
    request.log.info("PLIVO WEBSOCKET CONNECTED");

    let streamId: string | null = null;
    let callId: string | null = null;
    let mediaFrames = 0;
    let audioBytes = 0;

    socket.on("message", async (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage.toString()) as {
          event?: string;
          sequenceNumber?: number;
          start?: {
            callId?: string;
            streamId?: string;
            mediaFormat?: {
              encoding?: string;
              sampleRate?: number;
              channels?: number;
            };
          };
          media?: {
            track?: string;
            timestamp?: string;
            chunk?: number;
            payload?: string;
          };
        };

        if (message.event === "start") {
          streamId = message.start?.streamId ?? null;
          callId = message.start?.callId ?? null;

          request.log.info(
            {
              callId,
              streamId,
              mediaFormat: message.start?.mediaFormat,
            },
            "PLIVO STREAM STARTED"
          );

          if (callId) {
            await sql`
              UPDATE call_sessions
              SET
                mode = 'DETECTING_LANGUAGE',
                status = 'DETECTING_LANGUAGE',
                updated_at = NOW()
              WHERE provider_call_id = ${callId}
            `;

            const sessions = await sql`
              SELECT id
              FROM call_sessions
              WHERE provider_call_id = ${callId}
              ORDER BY created_at DESC
              LIMIT 1
            `;

            const sessionId = sessions[0]?.id;

            if (sessionId) {
              await sql`
                INSERT INTO call_events (
                  call_session_id,
                  event_type,
                  direction,
                  provider,
                  metadata
                )
                VALUES (
                  ${sessionId},
                  'PLIVO_STREAM_STARTED',
                  'INBOUND',
                  'plivo',
                  ${sql.json({
                    streamId,
                    encoding:
                      message.start?.mediaFormat?.encoding ?? null,
                    sampleRate:
                      message.start?.mediaFormat?.sampleRate ?? null,
                  })}
                )
              `;
            }
          }

          return;
        }

        if (message.event === "media") {
          mediaFrames++;

          const payload = message.media?.payload;

          if (payload) {
            audioBytes += Buffer.from(payload, "base64").length;
          }

          if (mediaFrames % 250 === 0) {
            request.log.info(
              {
                callId,
                streamId,
                mediaFrames,
                audioBytes,
              },
              "PLIVO AUDIO RECEIVING"
            );
          }

          return;
        }

        if (message.event === "stop") {
          request.log.info(
            {
              callId,
              streamId,
              mediaFrames,
              audioBytes,
            },
            "PLIVO STREAM STOPPED"
          );
        }
      } catch (error) {
        request.log.error(error, "PLIVO STREAM MESSAGE ERROR");
      }
    });

    socket.on("close", () => {
      request.log.info(
        {
          callId,
          streamId,
          mediaFrames,
          audioBytes,
        },
        "PLIVO WEBSOCKET CLOSED"
      );
    });

    socket.on("error", (error) => {
      request.log.error(error, "PLIVO WEBSOCKET ERROR");
    });
  }
);

// ============================================================
// PLIVO STREAM STATUS CALLBACK
// ============================================================

app.all("/plivo/stream-status", async (request, reply) => {
  const body =
    request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : {};

  request.log.info(
    {
      streamStatus: body,
    },
    "PLIVO STREAM STATUS"
  );

  reply.code(200).send({
    ok: true,
  });
});
// ============================================================
// PLIVO STATUS CALLBACK
// ============================================================

app.all("/plivo/status", async (request, reply) => {
  try {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};

    const providerCallId =
      typeof body.CallUUID === "string"
        ? body.CallUUID
        : undefined;

    const callStatus =
      typeof body.CallStatus === "string"
        ? body.CallStatus.toUpperCase()
        : "UNKNOWN";

    if (providerCallId) {
      const sessions = await sql`
        SELECT id
        FROM call_sessions
        WHERE provider_call_id = ${providerCallId}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      const sessionId = sessions[0]?.id;

      if (sessionId) {
        await sql`
          INSERT INTO call_events (
            call_session_id,
            event_type,
            provider,
            metadata
          )
          VALUES (
            ${sessionId},
            'PLIVO_STATUS',
            'plivo',
            ${sql.json({
              callStatus,
            })}
          )
        `;

        if (
          callStatus === "COMPLETED" ||
          callStatus === "HANGUP"
        ) {
          await sql`
            UPDATE call_sessions
            SET
              status = 'COMPLETED',
              mode = 'COMPLETED',
              ended_at = NOW(),
              duration_seconds =
                GREATEST(
                  0,
                  EXTRACT(
                    EPOCH FROM (NOW() - started_at)
                  )::INTEGER
                ),
              updated_at = NOW()
            WHERE id = ${sessionId}
          `;
        }
      }
    }

    reply.code(200).send({
      ok: true,
    });

  } catch (error) {
    request.log.error(error);

    reply.code(200).send({
      ok: false,
    });
  }
});

// ============================================================
// DEVELOPMENT TEST ROUTE
// ============================================================

app.post("/dev/test-inbound", async (_request, reply) => {
  const fakeCallId = `DEV-${Date.now()}`;

  const employees = await sql`
    SELECT id
    FROM employees
    WHERE employee_code = 'NUNES-001'
    LIMIT 1
  `;

  const employeeId = employees[0]?.id ?? null;

  const result = await sql`
    INSERT INTO call_sessions (
      call_id,
      provider_call_id,
      employee_id,
      direction,
      staff_language,
      customer_language,
      mode,
      translated,
      customer_number_masked,
      telephony_provider,
      status
    )
    VALUES (
      ${`dev-${fakeCallId}`},
      ${fakeCallId},
      ${employeeId},
      'INBOUND',
      'ta',
      NULL,
      'CONNECTING',
      FALSE,
      '********1234',
      'plivo',
      'CONNECTING'
    )
    RETURNING
      id,
      call_id,
      staff_language,
      mode,
      status
  `;

  return {
    ok: true,
    session: result[0],
  };
});

// ============================================================
// DATABASE SESSION CHECK
// ============================================================

app.get("/dev/latest-call", async () => {
  const calls = await sql`
    SELECT
      cs.id,
      cs.call_id,
      cs.provider_call_id,
      cs.direction,
      cs.staff_language,
      cs.customer_language,
      cs.mode,
      cs.status,
      cs.translated,
      cs.telephony_provider,
      cs.started_at,
      e.name AS employee_name
    FROM call_sessions cs
    LEFT JOIN employees e
      ON e.id = cs.employee_id
    ORDER BY cs.created_at DESC
    LIMIT 1
  `;

  return {
    call: calls[0] ?? null,
  };
});

// ============================================================
// START SERVER
// ============================================================

async function start() {
  try {
    await sql`SELECT 1`;

    console.log("");
    console.log("==========================================");
    console.log(" NUNES REALTIME SERVER");
    console.log("==========================================");
    console.log("DATABASE : CONNECTED");
    console.log("PLIVO    : WEBHOOK READY");
    console.log(`PORT     : ${PORT}`);
    console.log("==========================================");
    console.log("");

    await app.listen({
      port: PORT,
      host: "0.0.0.0",
    });

  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

async function shutdown() {
  console.log("Shutting down NUNES realtime server...");

  await app.close();
  await sql.end();

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();



