export type SupportedLanguage = "ta" | "hi";
export type DetectedLanguage = SupportedLanguage | "unknown";

export type RouterMode =
  | "DIRECT_BYPASS"
  | "TRANSLATION_ACTIVE"
  | "TEMPORARY_UNCERTAIN";

export interface LanguageObservation {
  language: DetectedLanguage;
  confidence: number;
}

export interface SmartRouterConfig {
  activationThreshold?: number;
  holdThreshold?: number;
  minimumConsecutive?: number;
  windowSize?: number;
  minimumAverageConfidence?: number;
}

export interface SmartRouterDecision {
  mode: RouterMode;
  stableLanguage: DetectedLanguage;
  candidateLanguage: DetectedLanguage;
  averageConfidence: number;
  consecutiveCount: number;
  sampleCount: number;
  changed: boolean;
}

export function decideMode(
  staff: SupportedLanguage,
  customer: DetectedLanguage,
  confidence: number,
  threshold = 0.85
): RouterMode {
  if (
    customer === "unknown" ||
    confidence < threshold
  ) {
    return "TEMPORARY_UNCERTAIN";
  }

  return staff === customer
    ? "DIRECT_BYPASS"
    : "TRANSLATION_ACTIVE";
}

export class SmartLanguageRouter {
  private readonly staffLanguage: SupportedLanguage;

  private readonly activationThreshold: number;
  private readonly holdThreshold: number;
  private readonly minimumConsecutive: number;
  private readonly windowSize: number;
  private readonly minimumAverageConfidence: number;

  private observations: LanguageObservation[] = [];

  private stableLanguage: DetectedLanguage = "unknown";
  private currentMode: RouterMode = "TEMPORARY_UNCERTAIN";

  constructor(
    staffLanguage: SupportedLanguage,
    config: SmartRouterConfig = {}
  ) {
    this.staffLanguage = staffLanguage;

    this.activationThreshold =
      config.activationThreshold ?? 0.85;

    this.holdThreshold =
      config.holdThreshold ?? 0.72;

    this.minimumConsecutive =
      config.minimumConsecutive ?? 2;

    this.windowSize =
      config.windowSize ?? 4;

    this.minimumAverageConfidence =
      config.minimumAverageConfidence ?? 0.78;
  }

  observe(
    language: DetectedLanguage,
    confidence: number
  ): SmartRouterDecision {
    const safeConfidence =
      Number.isFinite(confidence)
        ? Math.max(0, Math.min(1, confidence))
        : 0;

    this.observations.push({
      language,
      confidence: safeConfidence
    });

    if (this.observations.length > this.windowSize) {
      this.observations.shift();
    }

    const candidateLanguage =
      this.getCandidateLanguage();

    const candidateSamples =
      this.observations.filter(
        observation =>
          observation.language === candidateLanguage
      );

    const averageConfidence =
      candidateSamples.length > 0
        ? candidateSamples.reduce(
            (sum, observation) =>
              sum + observation.confidence,
            0
          ) / candidateSamples.length
        : 0;

    const consecutiveCount =
      this.getConsecutiveCount(candidateLanguage);

    const previousMode = this.currentMode;
    const previousLanguage = this.stableLanguage;

    if (candidateLanguage === "unknown") {
      if (
        this.stableLanguage === "unknown"
      ) {
        this.currentMode =
          "TEMPORARY_UNCERTAIN";
      }

      return this.buildDecision(
        candidateLanguage,
        averageConfidence,
        consecutiveCount,
        previousMode,
        previousLanguage
      );
    }

    const hasStrongSingleDetection =
      safeConfidence >= this.activationThreshold;

    const hasStableRollingDetection =
      consecutiveCount >= this.minimumConsecutive &&
      averageConfidence >=
        this.minimumAverageConfidence;

    const sameAsStableLanguage =
      candidateLanguage === this.stableLanguage;

    const canHoldExistingLanguage =
      sameAsStableLanguage &&
      safeConfidence >= this.holdThreshold;

    /*
     * V4.1 STRONG OPPOSITE-LANGUAGE SWITCH
     *
     * The rolling candidate can remain on the previous
     * language for one utterance because older observations
     * are still inside the rolling window.
     *
     * Example:
     *   stable = Hindi
     *   new observation = Tamil @ 1.00
     *
     * For a very strong new observation, switch using the
     * CURRENT observation rather than waiting for the
     * rolling candidate to change.
     *
     * Weak/noisy opposite detections still use hysteresis.
     */

    const strongOppositeLanguage =
      language !== "unknown" &&
      this.stableLanguage !== "unknown" &&
      language !== this.stableLanguage &&
      safeConfidence >= 0.95;

    if (strongOppositeLanguage) {
      this.stableLanguage = language;

      this.currentMode =
        this.staffLanguage === language
          ? "DIRECT_BYPASS"
          : "TRANSLATION_ACTIVE";
    }
    else if (
      hasStrongSingleDetection ||
      hasStableRollingDetection ||
      canHoldExistingLanguage
    ) {
      this.stableLanguage =
        candidateLanguage;

      this.currentMode =
        this.staffLanguage === candidateLanguage
          ? "DIRECT_BYPASS"
          : "TRANSLATION_ACTIVE";
    }
    else if (
      this.stableLanguage === "unknown"
    ) {
      this.currentMode =
        "TEMPORARY_UNCERTAIN";
    }

    return this.buildDecision(
      candidateLanguage,
      averageConfidence,
      consecutiveCount,
      previousMode,
      previousLanguage
    );
  }

  reset(): void {
    this.observations = [];
    this.stableLanguage = "unknown";
    this.currentMode = "TEMPORARY_UNCERTAIN";
  }

  getMode(): RouterMode {
    return this.currentMode;
  }

  getStableLanguage(): DetectedLanguage {
    return this.stableLanguage;
  }

  private getCandidateLanguage(): DetectedLanguage {
    const scores: Record<
      SupportedLanguage,
      number
    > = {
      ta: 0,
      hi: 0
    };

    for (const observation of this.observations) {
      if (
        observation.language === "ta" ||
        observation.language === "hi"
      ) {
        scores[observation.language] +=
          observation.confidence;
      }
    }

    if (scores.ta === 0 && scores.hi === 0) {
      return "unknown";
    }

    return scores.ta >= scores.hi
      ? "ta"
      : "hi";
  }

  private getConsecutiveCount(
    language: DetectedLanguage
  ): number {
    if (language === "unknown") {
      return 0;
    }

    let count = 0;

    for (
      let index = this.observations.length - 1;
      index >= 0;
      index--
    ) {
      if (
        this.observations[index].language !==
        language
      ) {
        break;
      }

      count++;
    }

    return count;
  }

  private buildDecision(
    candidateLanguage: DetectedLanguage,
    averageConfidence: number,
    consecutiveCount: number,
    previousMode: RouterMode,
    previousLanguage: DetectedLanguage
  ): SmartRouterDecision {
    return {
      mode: this.currentMode,
      stableLanguage: this.stableLanguage,
      candidateLanguage,
      averageConfidence,
      consecutiveCount,
      sampleCount: this.observations.length,
      changed:
        previousMode !== this.currentMode ||
        previousLanguage !== this.stableLanguage
    };
  }
}

export type MixedLanguage =
  | "ta"
  | "hi"
  | "unknown";

export interface MixedLanguageResult {
  language: MixedLanguage;
  source:
    | "native-script"
    | "romanized"
    | "provider"
    | "unknown";
  tamilScore: number;
  hindiScore: number;
}

const TAMIL_SCRIPT =
  /[\u0B80-\u0BFF]/u;

const DEVANAGARI_SCRIPT =
  /[\u0900-\u097F]/u;

const TANGLISH_WORDS = new Set([
  "enaku",
  "enakku",
  "ennaku",
  "yenaku",
  "yenakku",
  "venum",
  "venuma",
  "venumnu",
  "sollu",
  "sollunga",
  "solunga",
  "solra",
  "solranga",
  "iruku",
  "irukku",
  "irukka",
  "illa",
  "illai",
  "konjam",
  "romba",
  "evlo",
  "evalo",
  "eppo",
  "epdi",
  "apdi",
  "athu",
  "ithu",
  "intha",
  "antha",
  "enga",
  "namma",
  "nalla",
  "pannunga",
  "pannanum",
  "kudunga",
  "kidaikum",
  "kidaikkum",
  "seekiram",
  "thevai",
  "vanga",
  "pesunga",
  "theriyuma"
]);

const HINGLISH_WORDS = new Set([
  "mujhe",
  "mujko",
  "mujhko",
  "chahiye",
  "chaiye",
  "bataiye",
  "bataye",
  "batao",
  "kya",
  "kab",
  "kaise",
  "kitna",
  "kitne",
  "hai",
  "hain",
  "nahi",
  "nahin",
  "thoda",
  "thodi",
  "zyada",
  "jaldi",
  "karo",
  "kijiye",
  "dijiye",
  "dena",
  "milega",
  "milegi",
  "chalega",
  "acha",
  "accha",
  "haan",
  "kripya",
  "aur",
  "lekin",
  "kyunki"
]);

function tokenizeMixedText(
  text: string
): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function detectMixedLanguage(
  text: string,
  providerLanguage:
    | string
    | null
    | undefined,
  providerConfidence = 0
): MixedLanguageResult {

  const cleanText = text.trim();

  if (!cleanText) {
    return {
      language: "unknown",
      source: "unknown",
      tamilScore: 0,
      hindiScore: 0
    };
  }

  const words = tokenizeMixedText(cleanText);

  let tamilScore = 0;
  let hindiScore = 0;

  /*
   * V4 IMPORTANT:
   *
   * Do NOT immediately classify the whole utterance as Tamil
   * just because Saaras emitted Tamil characters.
   *
   * In codemix mode Hindi speech can sometimes be represented
   * phonetically using Tamil script.
   *
   * We therefore combine:
   *   1. native script evidence
   *   2. Tanglish/Hinglish lexical evidence
   *   3. Hindi phonetic cues written in Tamil script
   *   4. provider language as supporting evidence
   *
   * English technical/business terms are neutral.
   */

  const hasTamilScript =
    TAMIL_SCRIPT.test(cleanText);

  const hasDevanagari =
    DEVANAGARI_SCRIPT.test(cleanText);

  if (hasTamilScript) {
    tamilScore += 3;
  }

  if (hasDevanagari) {
    hindiScore += 6;
  }

  for (const word of words) {
    if (TANGLISH_WORDS.has(word)) {
      tamilScore += 2;
    }

    if (HINGLISH_WORDS.has(word)) {
      hindiScore += 2;
    }
  }

  /*
   * Saaras codemix may transliterate Hindi sounds
   * into Tamil characters.
   *
   * Examples observed in the real telephone test:
   *   ஹை       ~= hai
   *   ஜலதி     ~= jaldi
   *   ஜஹி      ~= chahiye
   *
   * These are Hindi conversational cues, not Tamil meaning.
   */

  const tamilScriptHindiPatterns = [
    /ஹை/u,
    /ஹாய்/u,
    /ஜலதி/u,
    /ஜல்தி/u,
    /ஜல்டி/u,
    /ஜஹி/u,
    /சாஹி/u,
    /சாஹியே/u,
    /சாஹியேய்/u,
    /சஹா/u,
    /சஹியே/u,
    /முஜே/u,
    /முஜ்ஹே/u,
    /தோடா/u,
    /தோட/u,
    /ஜ்யாதா/u,
    /ஜியாதா/u,
    /க்யா/u,
    /கித்னா/u,
    /கித்னே/u,
    /நஹி/u,
    /நஹீ/u,
    /பதாயே/u,
    /பதாயியே/u
  ];

  let tamilScriptHindiHits = 0;

  for (const pattern of tamilScriptHindiPatterns) {
    if (pattern.test(cleanText)) {
      tamilScriptHindiHits++;
    }
  }

  /*
   * One isolated phonetic hit is not enough to override
   * genuine Tamil.
   *
   * Two or more Hindi phonetic cues are strong evidence
   * of Hindi/Hinglish represented in Tamil script.
   */

  if (tamilScriptHindiHits >= 2) {
    hindiScore += tamilScriptHindiHits * 3;

    /*
     * Reduce generic Tamil-script weight because in this
     * situation script != spoken language.
     */
    tamilScore = Math.max(0, tamilScore - 2);
  }
  else if (tamilScriptHindiHits === 1) {
    hindiScore += 2;
  }

  const normalizedProvider =
    (providerLanguage ?? "")
      .toLowerCase();

  /*
   * Provider is supporting evidence only.
   * Transcript evidence remains stronger.
   */

  if (
    normalizedProvider === "ta" ||
    normalizedProvider === "ta-in"
  ) {
    tamilScore +=
      providerConfidence >= 0.85
        ? 2
        : 1;
  }

  if (
    normalizedProvider === "hi" ||
    normalizedProvider === "hi-in"
  ) {
    hindiScore +=
      providerConfidence >= 0.85
        ? 2
        : 1;
  }

  /*
   * en-IN remains neutral because technical/business
   * English is normal inside both Tanglish and Hinglish.
   */

  if (
    tamilScore === 0 &&
    hindiScore === 0
  ) {
    return {
      language: "unknown",
      source: "unknown",
      tamilScore,
      hindiScore
    };
  }

  if (hindiScore > tamilScore) {
    return {
      language: "hi",
      source:
        hasDevanagari || tamilScriptHindiHits >= 2
          ? "native-script"
          : normalizedProvider.startsWith("hi")
            ? "provider"
            : "romanized",
      tamilScore,
      hindiScore
    };
  }

  if (tamilScore > hindiScore) {
    return {
      language: "ta",
      source:
        hasTamilScript
          ? "native-script"
          : normalizedProvider.startsWith("ta")
            ? "provider"
            : "romanized",
      tamilScore,
      hindiScore
    };
  }

  /*
   * Tie safety:
   * Never guess when Tamil/Hindi evidence is equal.
   */

  return {
    language: "unknown",
    source: "unknown",
    tamilScore,
    hindiScore
  };
}

