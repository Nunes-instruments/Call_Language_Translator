import { encodeMulaw, pcm16Wav } from "./telephonyAudioCodec.js";
import type { PipelineLanguage, SarvamProviders, Transcript } from "./sarvamPipelineAdapters.js";

export interface DialogueFixture {
  role: "customer" | "staff";
  languageCode: "hi-IN" | "ta-IN";
  transcriptText: string;
  confidence: number;
  expectedTranslation: string;
  audioPcm: Int16Array;
  audioMulaw: Buffer;
  audioWav: Buffer;
}

/**
 * Synthesizes realistic 8kHz speech-like PCM frames using multi-formant audio synthesis.
 * Simulates human vowel formants (F1 ~ 500Hz, F2 ~ 1500Hz, F3 ~ 2500Hz) with natural pitch contours.
 */
export function generateSpeechPcm(durationMs: number, pitchHz = 130): Int16Array {
  const sampleRate = 8000;
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const pcm = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    // Vibrato / natural pitch variation
    const pitch = pitchHz + 10 * Math.sin(2 * Math.PI * 4 * t);
    const fundamental = Math.sin(2 * Math.PI * pitch * t);
    const f1 = 0.5 * Math.sin(2 * Math.PI * 520 * t);
    const f2 = 0.3 * Math.sin(2 * Math.PI * 1480 * t);
    const f3 = 0.15 * Math.sin(2 * Math.PI * 2500 * t);

    // Envelope (fade-in, sustain, fade-out)
    const attack = Math.min(1, i / (0.05 * sampleRate));
    const release = Math.min(1, (sampleCount - i) / (0.05 * sampleRate));
    const envelope = attack * release;

    const sample = Math.round(7000 * envelope * (0.4 * fundamental + f1 + f2 + f3));
    pcm[i] = Math.max(-32768, Math.min(32767, sample));
  }

  return pcm;
}

/** Pre-configured instrumentation dialogue turns */
export function createDialogueFixtures(): {
  customerHindi: DialogueFixture;
  staffTamil: DialogueFixture;
  customerTamilDirect: DialogueFixture;
} {
  // Customer Turn: Hindi inquiry with industrial equipment terms
  const customerPcm = generateSpeechPcm(1200, 140);
  const customerMulaw = encodeMulaw(customerPcm);
  const customerWav = pcm16Wav(customerPcm, 8000);
  const customerHindi: DialogueFixture = {
    role: "customer",
    languageCode: "hi-IN",
    transcriptText: "मुझे Fluke 754 प्रेशर कैलिब्रेटर चाहिए 4-20 mA",
    confidence: 0.98,
    expectedTranslation: "எனக்கு Fluke 754 பிரஷர் கேலிபிரேட்டர் தேவை 4-20 mA",
    audioPcm: customerPcm,
    audioMulaw: customerMulaw,
    audioWav: customerWav,
  };

  // Staff Turn: Tamil technical response with price and GST
  const staffPcm = generateSpeechPcm(1500, 180);
  const staffMulaw = encodeMulaw(staffPcm);
  const staffWav = pcm16Wav(staffPcm, 8000);
  const staffTamil: DialogueFixture = {
    role: "staff",
    languageCode: "ta-IN",
    transcriptText: "எங்களிடம் Fluke 754 இருப்பு உள்ளது ₹12,500 பிளஸ் GST 18%",
    confidence: 0.99,
    expectedTranslation: "हमारे पास Fluke 754 स्टॉक में है ₹12,500 प्लस GST 18%",
    audioPcm: staffPcm,
    audioMulaw: staffMulaw,
    audioWav: staffWav,
  };

  // Customer Direct Turn: Tamil speaker (triggers direct mode)
  const directPcm = generateSpeechPcm(1000, 135);
  const directMulaw = encodeMulaw(directPcm);
  const directWav = pcm16Wav(directPcm, 8000);
  const customerTamilDirect: DialogueFixture = {
    role: "customer",
    languageCode: "ta-IN",
    transcriptText: "வணக்கம் எனக்கு GE Druck பிரஷர் கேலிபிரேட்டர் தேவை",
    confidence: 0.97,
    expectedTranslation: "வணக்கம் எனக்கு GE Druck பிரஷர் கேலிபிரேட்டர் தேவை",
    audioPcm: directPcm,
    audioMulaw: directMulaw,
    audioWav: directWav,
  };

  return { customerHindi, staffTamil, customerTamilDirect };
}

/**
 * Realistic offline mock provider implementing Sarvam STT, translation and TTS.
 * Maps spoken audio to true Hindi/Tamil conversations while ensuring zero external network calls.
 */
export class RealisticOfflineTranslationProvider implements SarvamProviders {
  readonly mode = "mock" as const;
  readonly fixtures = createDialogueFixtures();

  readonly calls = {
    stt: 0,
    translation: 0,
    tts: 0,
  };

  private queuedTranscripts: Transcript[] = [];

  constructor(customTranscripts?: Transcript[]) {
    if (customTranscripts) {
      this.queuedTranscripts = [...customTranscripts];
    }
  }

  queueTranscript(t: Transcript): void {
    this.queuedTranscripts.push(t);
  }

  async transcribe(pcm: Int16Array, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted();
    this.calls.stt++;

    if (this.queuedTranscripts.length > 0) {
      return this.queuedTranscripts.shift()!;
    }

    // Energy check: silent audio returns empty transcript
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    if (rms < 500) {
      return { text: "", language: null, confidence: 0, final: true };
    }

    // Default to customer Hindi inquiry for first call, then staff Tamil reply
    if (this.calls.stt % 2 === 1) {
      return {
        text: this.fixtures.customerHindi.transcriptText,
        language: this.fixtures.customerHindi.languageCode,
        confidence: this.fixtures.customerHindi.confidence,
        final: true,
      };
    } else {
      return {
        text: this.fixtures.staffTamil.transcriptText,
        language: this.fixtures.staffTamil.languageCode,
        confidence: this.fixtures.staffTamil.confidence,
        final: true,
      };
    }
  }

  async translate(
    text: string,
    source: PipelineLanguage,
    target: PipelineLanguage,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted();
    this.calls.translation++;

    // Hindi -> Tamil translation with entity token preservation
    if (source === "hi-IN" && target === "ta-IN") {
      let translated = text;
      // Common phrase translation mappings
      translated = translated.replace(/मुझे/g, "எனக்கு");
      translated = translated.replace(/चाहिए/g, "தேவை");
      translated = translated.replace(/प्रेशर कैलिब्रेटर/g, "பிரஷர் கேலிபிரேட்டர்");
      translated = translated.replace(/कीमत/g, "விலை");
      translated = translated.replace(/उपलब्ध है/g, "இருப்பு உள்ளது");
      return translated;
    }

    // Tamil -> Hindi translation with entity token preservation
    if (source === "ta-IN" && target === "hi-IN") {
      let translated = text;
      translated = translated.replace(/எங்களிடம்/g, "हमारे पास");
      translated = translated.replace(/இருப்பு உள்ளது/g, "स्टॉक में है");
      translated = translated.replace(/பிளஸ்/g, "प्लस");
      translated = translated.replace(/தேவை/g, "चाहिए");
      translated = translated.replace(/பிரஷர் கேலிபிரேட்டர்/g, "प्रेशर कैलिब्रेटर");
      return translated;
    }

    return text;
  }

  async synthesize(
    text: string,
    target: PipelineLanguage,
    signal: AbortSignal
  ): Promise<{ audio: Buffer; encoding: "audio/x-mulaw"; sampleRate: 8000 }> {
    signal.throwIfAborted();
    this.calls.tts++;

    // Synthesize realistic audio frames proportional to sentence length
    const durationMs = Math.max(300, Math.min(2500, text.length * 40));
    const pitch = target === "ta-IN" ? 170 : 135;
    const pcm = generateSpeechPcm(durationMs, pitch);
    const mulaw = encodeMulaw(pcm);

    return {
      audio: mulaw,
      encoding: "audio/x-mulaw",
      sampleRate: 8000,
    };
  }
}

