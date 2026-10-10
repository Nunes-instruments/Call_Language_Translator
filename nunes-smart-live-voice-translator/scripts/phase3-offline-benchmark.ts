import { writeFileSync } from "node:fs";
import { IndependentTranslationPipeline, MockPlaybackSink } from "../apps/realtime-server/src/independentTranslationPipeline.js";
import { ScriptedSarvamMock } from "../apps/realtime-server/src/sarvamPipelineAdapters.js";
import { encodeMulaw } from "../apps/realtime-server/src/telephonyAudioCodec.js";
async function main() {
const providers = new ScriptedSarvamMock(), pipeline = new IndependentTranslationPipeline("benchmark", providers);
const customer = { sessionId: "benchmark", role: "customer" as const, callUuid: "customer", streamId: "customer-stream", socket: {} };
const staff = { sessionId: "benchmark", role: "staff" as const, callUuid: "staff", streamId: "staff-stream", socket: {} };
pipeline.bind(customer); pipeline.bind(staff);
const audio = encodeMulaw(Int16Array.from({ length: 1600 }, (_, i) => Math.round(5000 * Math.sin(i * .2)))).toString("base64");
const measurements: typeof pipeline.metrics.timings = [];
for (let index = 0; index < 100; index++) {
  providers.transcripts.push({ text: "mujhe Fluke 754 chahiye", language: "hi-IN", confidence: .99, final: true });
  pipeline.receive(customer, index + 1, audio); pipeline.flush("customer"); await pipeline.idle();
  measurements.push({ ...pipeline.metrics.timings.at(-1)! });
  pipeline.drainMock("customer", new MockPlaybackSink(), { offlineTranslationAuthorized: true, simulatedIsolationVerified: true });
}
const stats = Object.fromEntries((["stt", "translation", "tts", "total"] as const).map(stage => {
  const values = measurements.map(item => item[stage]).sort((a, b) => a - b);
  return [stage, { medianMs: values[49], p95Ms: values[94], maxMs: values[99] }];
}));
const result = { kind: "offline-immediate-scripted-mocks", iterations: 100, inputAudioMs: 200, segmentationSilenceMs: 300, excludes: ["network", "provider inference", "telephony", "speech capture", "playback"], stats, providerCalls: { realPlivo: 0, realSarvam: 0 }, actualAudioIsolationVerified: false };
writeFileSync("PHASE3_OFFLINE_LATENCY.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result)); pipeline.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
