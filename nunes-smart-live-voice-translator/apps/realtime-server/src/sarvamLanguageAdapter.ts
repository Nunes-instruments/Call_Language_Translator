import {
  decideCallLanguage,
  type CallLanguage,
  type LanguageDecision
} from "./callLanguageDecision";

export type SarvamLanguageInput = {
  language_code?: unknown;
  language?: unknown;
  detected_language?: unknown;
};

export function normalizeSarvamLanguage(
  input: SarvamLanguageInput | null | undefined
): CallLanguage {
  if (!input || typeof input !== "object") {
    return "unknown";
  }

  const raw =
    input.language_code ??
    input.detected_language ??
    input.language;

  if (typeof raw !== "string") {
    return "unknown";
  }

  const code = raw.trim().toLowerCase().replace(/_/g, "-");

  if (code === "ta" || code === "ta-in" ||
      code === "tamil") {
    return "ta-IN";
  }

  if (code === "hi" || code === "hi-in" ||
      code === "hindi") {
    return "hi-IN";
  }

  return "unknown";
}

export function decideFromSarvamLanguage(
  input: SarvamLanguageInput | null | undefined
): LanguageDecision {
  return decideCallLanguage(
    normalizeSarvamLanguage(input),
    "ta-IN"
  );
}
