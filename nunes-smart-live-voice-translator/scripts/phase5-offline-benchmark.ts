import { writeFileSync } from "node:fs";
import { IndependentTranslationPipeline, MockPlaybackSink, type AudioOwner } from "../apps/realtime-server/src/independentTranslationPipeline.js";
import { ScriptedSarvamMock } from "../apps/realtime-server/src/sarvamPipelineAdapters.js";
import { encodeMulaw } from "../apps/realtime-server/src/telephonyAudioCodec.js";

async function runBenchmark() {
  const iterations = 100;
  const mock = new ScriptedSarvamMock();
  const pipeline = new IndependentTranslationPipeline("benchmark-p5", mock);

  const customer: AudioOwner = { sessionId: "benchmark-p5", role: "customer", callUuid: "c-bench", streamId: "cs-bench", socket: {} };
  const staff: AudioOwner = { sessionId: "benchmark-p5", role: "staff", callUuid: "s-bench", streamId: "ss-bench", socket: {} };
  pipeline.bind(customer);
  pipeline.bind(staff);

  const pcmTone = Int16Array.from({ length: 1600 }, (_, i) => Math.round(5000 * Math.sin(i * 0.2)));
  const audio = encodeMulaw(pcmTone).toString("base64");

  const measurements: Array<{ stt: number; translation: number; tts: number; total: number }> = [];

  // 1. Bidirectional Hindi -> Tamil and Tamil -> Hindi runs
  for (let i = 0; i < iterations; i++) {
    const isCustomer = i % 2 === 0;
    if (isCustomer) {
      mock.transcripts.push({
        text: "mujhe Fluke 754 pressure calibrator chahiye 4-20 mA ₹12,500 GST 18%",
        language: "hi-IN",
        confidence: 0.99,
        final: true
      });
      pipeline.receive(customer, i + 1, audio);
      pipeline.flush("customer");
      await pipeline.idle();
      pipeline.drainMock("customer", new MockPlaybackSink(), { offlineTranslationAuthorized: true, simulatedIsolationVerified: true });
    } else {
      mock.transcripts.push({
        text: "enakku pressure calibrator venum 2 10 bar",
        language: "ta-IN",
        confidence: 0.99,
        final: true
      });
      pipeline.receive(staff, i + 1, audio);
      pipeline.flush("staff");
      await pipeline.idle();
      pipeline.drainMock("staff", new MockPlaybackSink(), { offlineTranslationAuthorized: true, simulatedIsolationVerified: true });
    }

    const latest = pipeline.metrics.timings.at(-1);
    if (latest) {
      measurements.push({ ...latest });
    }
  }

  // 2. Cancellation latency test
  const cancelStart = performance.now();
  let cancelResolver: (() => void) | undefined;
  mock.transcribe = () => new Promise<never>((_, reject) => {
    cancelResolver = () => reject(new Error("CANCELLED"));
  });
  pipeline.receive(customer, iterations + 1, audio);
  pipeline.flush("customer");
  pipeline.close();
  cancelResolver?.();
  await pipeline.idle();
  const cancellationLatencyMs = performance.now() - cancelStart;

  // 3. Compute statistical percentiles
  const calculatePercentiles = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const medianIndex = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    return {
      medianMs: sorted[medianIndex] ?? 0,
      p95Ms: sorted[p95Index] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
    };
  };

  const stats = {
    stt: calculatePercentiles(measurements.map(m => m.stt)),
    translation: calculatePercentiles(measurements.map(m => m.translation)),
    tts: calculatePercentiles(measurements.map(m => m.tts)),
    total: calculatePercentiles(measurements.map(m => m.total)),
    cancellationMs: cancellationLatencyMs
  };

  const report = {
    phase: "Phase 5 Offline Translation Pipeline Latency & Deterministic Benchmarking",
    kind: "offline-immediate-scripted-mocks",
    iterations,
    inputAudioMs: 200,
    segmentationSilenceMs: 300,
    bidirectionalRatio: "50% customer (hi->ta), 50% staff (ta->hi)",
    excludes: [
      "public network transit",
      "billable Sarvam cloud inference",
      "real Plivo telephony SIP signaling",
      "physical microphone capture",
      "speaker hardware playback"
    ],
    stats,
    backpressure: {
      maxPendingConcurrentUtterances: 4,
      maxPreparedAudioBytes: 128000,
      queueOverflowProtected: true
    },
    providerCalls: {
      realPlivo: 0,
      realSarvam: 0
    },
    actualAudioIsolationVerified: false,
    productionTranslationAuthorized: false,
    timestamp: new Date().toISOString()
  };

  writeFileSync("PHASE5_OFFLINE_LATENCY.json", JSON.stringify(report, null, 2) + "\n");
  console.log("Phase 5 latency benchmark generated successfully.");
  console.log(JSON.stringify(report, null, 2));
}

runBenchmark().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

