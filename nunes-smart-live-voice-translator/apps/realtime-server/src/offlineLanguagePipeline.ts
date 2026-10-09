import {
  normalizeSarvamLanguage,
  type SarvamLanguageInput
} from "./sarvamLanguageAdapter";
import { simulateCallRouting } from "./simulatedCallRouter";

export function runOfflineLanguagePipeline(
  sessionId: string,
  customerUuid: string,
  staffUuid: string,
  sarvamResult: SarvamLanguageInput | null | undefined
) {
  const detectedLanguage = normalizeSarvamLanguage(
    sarvamResult
  );

  const route = simulateCallRouting(
    sessionId,
    customerUuid,
    staffUuid,
    detectedLanguage,
    "ta-IN"
  );

  return {
    ...route,
    detectedLanguage,
    liveAudioEnabled: false as const,
    sarvamApiCalled: false as const
  };
}
