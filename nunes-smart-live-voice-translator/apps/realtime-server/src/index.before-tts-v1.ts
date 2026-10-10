import Fastify from "fastify";
import { SmartLanguageRouter, detectMixedLanguage } from "@nunes/language-router";
import {
  protectEntities,
  restoreEntities,
  verifyEntityIntegrity
} from "@nunes/translation";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import postgres from "postgres";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import WebSocket from "ws";
import speech from "@google-cloud/speech";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

const PORT = Number(process.env.PORT || 8787);

const sarvamApiKey = process.env.SARVAM_API_KEY;

if (!sarvamApiKey) {
  throw new Error("SARVAM_API_KEY is missing from root .env");
}

const SARVAM_API_KEY: string = sarvamApiKey;

async function translateHindiToTamilSafe(input: string) {
  const protectedResult = protectEntities(input);

  const startedAt = performance.now();

  const response = await fetch(
    "https://api.sarvam.ai/translate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": SARVAM_API_KEY
      },
      body: JSON.stringify({
        input: protectedResult.text,
        source_language_code: "hi-IN",
        target_language_code: "ta-IN",
        model: "sarvam-translate:v1"
      })
    }
  );

  const latencyMs =
    Math.round(performance.now() - startedAt);

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Sarvam translation HTTP ${response.status}: ${body}`
    );
  }

  const result = JSON.parse(body) as {
    translated_text?: unknown;
  };

  if (typeof result.translated_text !== "string") {
    throw new Error(
      "Sarvam response missing translated_text"
    );
  }

  const restoredText = restoreEntities(
    result.translated_text,
    protectedResult.entities
  );

  const integrity = verifyEntityIntegrity(
    restoredText,
    protectedResult.entities
  );

  if (!integrity.valid) {
    throw new Error(
      `Entity integrity failed: ${integrity.missing.join(", ")}`
    );
  }

  return {
    text: restoredText,
    latencyMs,
    entities:
      protectedResult.entities.map(
        entity => entity.original
      )
  };
}

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

    let sarvamSocket: WebSocket | null = null;
    let sarvamReady = false;

      let currentRouterMode:
        | "DIRECT_BYPASS"
        | "TRANSLATION_ACTIVE"
        | "TEMPORARY_UNCERTAIN" = "TEMPORARY_UNCERTAIN";

      const STAFF_LANGUAGE: "ta" | "hi" = "ta";

      const smartRouter = new SmartLanguageRouter(
        STAFF_LANGUAGE,
        {
          activationThreshold: 0.85,
          holdThreshold: 0.72,
          minimumConsecutive: 2,
          windowSize: 4,
          minimumAverageConfidence: 0.78
        }
      );
    const pendingAudio: string[] = [];


    let googleRecognizeStream: any = null;
    const googleSpeechClient = new speech.SpeechClient();

    const connectGoogleStt = () => {
      console.log("");
      console.log("==========================================");
      console.log(" GOOGLE STT STREAM STARTING");
      console.log("==========================================");

      googleRecognizeStream = googleSpeechClient
        .streamingRecognize({
          config: {
            encoding: "MULAW" as any,
            sampleRateHertz: 8000,
            languageCode: "hi-IN",
            alternativeLanguageCodes: ["ta-IN", "en-IN"],
            enableAutomaticPunctuation: true,
            speechContexts: [
              {
                phrases: [
                  "Fluke",
                  "Fluke pressure calibrator",
                  "GE Druck",
                  "Druck",
                  "DPI 620G",
                  "GE Druck DPI 620G",
                  "pressure calibrator",
                  "temperature calibrator",
                  "process calibrator",
                  "loop calibrator",
                  "dry block calibrator",
                  "GST",
                  "ASTM",
                  "ISO",
                  "4-20 mA",
                  "delivery time",
                  "quotation"
                ],
                boost: 20
              }
            ]
          },
          interimResults: true
        })
        .on("data", (data: any) => {
          const result = data?.results?.[0];
          const alternative = result?.alternatives?.[0];

          if (
            result?.isFinal === true &&
            typeof alternative?.transcript === "string" &&
            alternative.transcript.trim()
          ) {
            console.log("");
            console.log("==========================================");
            console.log(" NUNES GOOGLE STT FINAL");
            console.log("==========================================");
            console.log(`CALL       : ${callId ?? "unknown"}`);
            console.log(`LANGUAGE   : ${result.languageCode ?? "unknown"}`);
            console.log(`TEXT       : ${alternative.transcript.trim()}`);
            console.log(`CONFIDENCE : ${alternative.confidence ?? 0}`);
            console.log("MODE       : BENCHMARK ONLY");
            console.log("==========================================");
          }
        })
        .on("error", (error: Error) => {
          request.log.error(
            {
              callId,
              error: error.message
            },
            "GOOGLE REALTIME STT ERROR"
          );
        });

      request.log.info(
        { callId },
        "GOOGLE REALTIME STT BENCHMARK CONNECTED"
      );
    };

    const connectSarvam = () => {
      const sarvamKeyterms = encodeURIComponent(
        JSON.stringify([
          "Fluke",
          "GE Druck",
          "Druck",
          "DPI 620G",
          "Fluke pressure calibrator",
          "GE Druck DPI 620G",
          "pressure calibrator",
          "temperature calibrator",
          "process calibrator",
          "loop calibrator",
          "multifunction calibrator",
          "dry block calibrator",
          "pressure gauge",
          "manometer",
          "multimeter",
          "oscilloscope",
          "4-20 mA",
          "GST",
          "ASTM",
          "ISO",
          "quotation",
          "delivery time",
          "IndiaMART",
          "Nunes Instrumentation"
        ])
      );
      const sarvamUrl =
        "wss://api.sarvam.ai/speech-to-text-realtime/ws" +
        "?language_code=auto" +
        "&model=saaras:v4" +
        "&mode=codemix" +
        "&keyterms=" + sarvamKeyterms +
        "&encoding=mulaw" +
        "&sample_rate=8000" +
        "&stream_type=balanced" +
        "&endpointing=vad" +
        "&silence_duration_ms=500" +
        "&min_speech_duration_ms=250";

      sarvamSocket = new WebSocket(sarvamUrl, {
        headers: {
          "Api-Subscription-Key": SARVAM_API_KEY,
        },
      });

      sarvamSocket.on("open", () => {
        sarvamReady = true;

        request.log.info(
          { callId },
          "SARVAM REALTIME STT CONNECTED"
        );

        while (pendingAudio.length > 0) {
          const audio = pendingAudio.shift();

          if (audio && sarvamSocket?.readyState === WebSocket.OPEN) {
            sarvamSocket.send(
              JSON.stringify({
                event: "audio_input",
                audio,
              })
            );
          }
        }
      });

      sarvamSocket.on("message", async (data) => {
        try {
          const result = JSON.parse(data.toString()) as Record<string, unknown>;

          const transcript =
            typeof result.transcript === "string"
              ? result.transcript
              : typeof result.text === "string"
                ? result.text
                : null;

          const language =
            typeof result.language_code === "string"
              ? result.language_code
              : typeof result.language === "string"
                ? result.language
                : "unknown";

          const event =
            typeof result.event === "string"
              ? result.event
              : typeof result.type === "string"
                ? result.type
                : "transcript";

          if (
            transcript?.trim() &&
            (event === "transcript.final" || event.includes("final"))
          ) {
            console.log("");
            console.log("========== SARVAM FINAL RAW ==========");
            console.log(JSON.stringify(result, null, 2));
            console.log("======================================");
          }

          if (
            transcript?.trim() &&
            event === "transcript.final"
          ) {
            const rawConfidence = result.language_confidence;

            const confidence =
              typeof rawConfidence === "number"
                ? rawConfidence
                : 0;


            const mixedDetection =
              detectMixedLanguage(
                transcript.trim(),
                language,
                confidence
              );

            const normalizedLanguage =
              mixedDetection.language;

            /*
             * Sarvam provider language is only one signal.
             *
             * Tanglish/Hinglish may arrive as en-IN,
             * especially when technical English words
             * such as Fluke, pressure calibrator,
             * delivery, GST or model numbers are spoken.
             */
            let routingConfidence = confidence;

            if (
              mixedDetection.source === "native-script"
            ) {
              routingConfidence =
                Math.max(
                  routingConfidence,
                  0.95
                );
            }

            if (
              mixedDetection.source === "romanized"
            ) {
              const lexicalScore =
                Math.max(
                  mixedDetection.tamilScore,
                  mixedDetection.hindiScore
                );

              if (lexicalScore >= 2) {
                routingConfidence =
                  Math.max(
                    routingConfidence,
                    0.90
                  );
              } else if (lexicalScore === 1) {
                routingConfidence =
                  Math.max(
                    routingConfidence,
                    0.79
                  );
              }
            }

            const routerDecision =
              smartRouter.observe(
                normalizedLanguage,
                routingConfidence
              );

            currentRouterMode =
              routerDecision.mode;

            if (
              currentRouterMode === "TRANSLATION_ACTIVE" &&
              routerDecision.stableLanguage === "hi"
            ) {
              try {
                const translated =
                  await translateHindiToTamilSafe(
                    transcript.trim()
                  );

                console.log("");
                console.log("==========================================");
                console.log(" NUNES LIVE HINDI -> TAMIL");
                console.log("==========================================");
                console.log(`CALL      : ${callId ?? "unknown"}`);
                console.log(`HINDI     : ${transcript.trim()}`);
                console.log(`TAMIL     : ${translated.text}`);
                console.log(`LATENCY   : ${translated.latencyMs} ms`);
                console.log(
                  `PROTECTED : ${
                    translated.entities.length
                      ? translated.entities.join(" | ")
                      : "NONE"
                  }`
                );
                console.log("INTEGRITY : PASS");
                console.log("==========================================");
                console.log("");
              } catch (error) {
                request.log.error(
                  {
                    callId,
                    error:
                      error instanceof Error
                        ? error.message
                        : String(error)
                  },
                  "LIVE HINDI TO TAMIL TRANSLATION FAILED"
                );
              }
            }

            console.log("");
            console.log("==========================================");
            console.log(" NUNES SMART LANGUAGE ROUTER");
            console.log("==========================================");
            console.log(`CALL              : ${callId ?? "unknown"}`);
            console.log(`STAFF LANGUAGE    : ${STAFF_LANGUAGE}`);
            console.log(`CUSTOMER LANGUAGE : ${normalizedLanguage}`);
            console.log(`RAW LANGUAGE      : ${language}`);
            console.log(`PROVIDER CONFIDENCE: ${confidence}`);
            console.log(`MIXED SOURCE       : ${mixedDetection.source}`);
            console.log(`TAMIL SCORE        : ${mixedDetection.tamilScore}`);
            console.log(`HINDI SCORE        : ${mixedDetection.hindiScore}`);
            console.log(`ROUTING CONFIDENCE : ${routingConfidence}`);
            console.log(`STABLE LANGUAGE   : ${routerDecision.stableLanguage}`);
            console.log(`CANDIDATE LANGUAGE: ${routerDecision.candidateLanguage}`);
            console.log(`ROLLING AVERAGE   : ${routerDecision.averageConfidence.toFixed(3)}`);
            console.log(`CONSECUTIVE       : ${routerDecision.consecutiveCount}`);
            console.log(`WINDOW SAMPLES    : ${routerDecision.sampleCount}`);
            console.log(`ROUTER CHANGED    : ${routerDecision.changed}`);
            console.log(`ROUTER MODE       : ${currentRouterMode}`);
            console.log("==========================================");
            console.log("");

            if (callId) {
              void sql`
                UPDATE call_sessions
                SET
                  customer_language = ${routerDecision.stableLanguage},
                  mode = ${currentRouterMode},
                  translated = ${currentRouterMode === "TRANSLATION_ACTIVE"},
                  updated_at = NOW()
                WHERE provider_call_id = ${callId}
                   OR id::text = ${callId}
              `.catch((error) => {
                request.log.error(
                  error,
                  "SMART ROUTER DATABASE UPDATE FAILED"
                );
              });

              void sql`
                INSERT INTO call_events (
                  call_session_id,
                  event_type,
                  metadata
                )
                SELECT
                  id,
                  'LANGUAGE_ROUTER_DECISION',
                  ${JSON.stringify({
                    staffLanguage: STAFF_LANGUAGE,
                    customerLanguage: normalizedLanguage,
                    stableLanguage: routerDecision.stableLanguage,
                    candidateLanguage: routerDecision.candidateLanguage,
                    rawLanguage: language,
                    confidence,
                    routingConfidence,
                    mixedLanguageSource: mixedDetection.source,
                    tamilScore: mixedDetection.tamilScore,
                    hindiScore: mixedDetection.hindiScore,
                    rollingAverage: routerDecision.averageConfidence,
                    consecutiveCount: routerDecision.consecutiveCount,
                    sampleCount: routerDecision.sampleCount,
                    changed: routerDecision.changed,
                    mode: currentRouterMode
                  })}::jsonb
                FROM call_sessions
                WHERE provider_call_id = ${callId}
                   OR id::text = ${callId}
                LIMIT 1
              `.catch((error) => {
                request.log.error(
                  error,
                  "SMART ROUTER EVENT INSERT FAILED"
                );
              });
            }
          }

          if (transcript?.trim()) {
            console.log("");
            console.log("==========================================");
            console.log(" NUNES LIVE SPEECH");
            console.log("==========================================");
            console.log(`CALL     : ${callId ?? "unknown"}`);
            console.log(`LANGUAGE : ${language}`);
            console.log(`EVENT    : ${event}`);
            console.log(`TEXT     : ${transcript}`);
            console.log("==========================================");
            console.log("");
          }
        } catch {
          request.log.debug(
            { sarvamMessage: data.toString() },
            "SARVAM MESSAGE"
          );
        }
      });

      sarvamSocket.on("close", (code, reason) => {
        sarvamReady = false;

        request.log.info(
          {
            callId,
            code,
            reason: reason.toString(),
          },
          "SARVAM REALTIME STT CLOSED"
        );
      });

      sarvamSocket.on("error", (error) => {
        sarvamReady = false;
        request.log.error(error, "SARVAM REALTIME STT ERROR");
      });
    };

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

          connectSarvam();
          connectGoogleStt();

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

            
if (googleRecognizeStream) {
            
  googleRecognizeStream.write(
            
    Buffer.from(payload, "base64")
            
  );
            
}

            if (
              sarvamReady &&
              sarvamSocket?.readyState === WebSocket.OPEN
            ) {
              sarvamSocket.send(
                JSON.stringify({
                  event: "audio_input",
                  audio: payload,
                })
              );
            } else if (pendingAudio.length < 250) {
              pendingAudio.push(payload);
            }
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
          if (sarvamSocket) {
            sarvamSocket.close();
            sarvamSocket = null;
            sarvamReady = false;
          }

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
      if (sarvamSocket) {
        sarvamSocket.close();
        sarvamSocket = null;
        sarvamReady = false;
      }

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












