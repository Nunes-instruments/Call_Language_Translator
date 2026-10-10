import "dotenv/config";
import WebSocket from "ws";

const key = process.env.SARVAM_API_KEY;

if (!key) {
  console.error("SARVAM_API_KEY : MISSING");
  process.exit(1);
}

const url =
  "wss://api.sarvam.ai/speech-to-text-realtime/ws" +
  "?language_code=auto" +
  "&model=saaras:v3-realtime" +
  "&encoding=mulaw" +
  "&sample_rate=8000" +
  "&stream_type=fast" +
  "&endpointing=vad" +
  "&silence_duration_ms=500" +
  "&min_speech_duration_ms=250";

console.log("====================================");
console.log(" NUNES SARVAM REALTIME STT TEST");
console.log("====================================");
console.log("API KEY    : FOUND");
console.log("LANGUAGE   : AUTO");
console.log("AUDIO      : MULAW 8000 Hz");
console.log("CONNECTING...");
console.log("");

const ws = new WebSocket(url, {
  headers: {
    "Api-Subscription-Key": key
  }
});

const timer = setTimeout(() => {
  console.error("RESULT     : TIMEOUT");
  ws.close();
  process.exit(1);
}, 10000);

ws.on("open", () => {
  clearTimeout(timer);

  console.log("RESULT     : CONNECTED");
  console.log("SARVAM STT : READY");
  console.log("====================================");

  ws.close();
});

ws.on("message", (data) => {
  console.log("MESSAGE    :", data.toString());
});

ws.on("error", (error) => {
  clearTimeout(timer);

  console.error("RESULT     : FAILED");
  console.error("ERROR      :", error.message);

  process.exit(1);
});
