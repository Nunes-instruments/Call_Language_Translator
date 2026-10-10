export type CallLanguage = "ta-IN" | "hi-IN" | "unknown";

export type LanguageDecision =
  | { mode: "bypass"; reason: string }
  | {
      mode: "translate";
      customerTarget: "ta-IN";
      staffTarget: "hi-IN";
    }
  | { mode: "hold"; reason: string };

export function decideCallLanguage(
  customerLanguage: CallLanguage,
  staffLanguage: CallLanguage = "ta-IN"
): LanguageDecision {
  if (customerLanguage === "unknown" ||
      staffLanguage === "unknown") {
    return {
      mode: "hold",
      reason: "LANGUAGE_NOT_CONFIRMED"
    };
  }

  if (customerLanguage === "ta-IN" &&
      staffLanguage === "ta-IN") {
    return {
      mode: "bypass",
      reason: "SAME_LANGUAGE"
    };
  }

  if (customerLanguage === "hi-IN" &&
      staffLanguage === "ta-IN") {
    return {
      mode: "translate",
      customerTarget: "ta-IN",
      staffTarget: "hi-IN"
    };
  }

  return {
    mode: "hold",
    reason: "UNSUPPORTED_LANGUAGE_PAIR"
  };
}
