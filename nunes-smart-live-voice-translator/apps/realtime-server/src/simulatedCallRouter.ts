import {
  decideCallLanguage,
  type CallLanguage,
  type LanguageDecision
} from "./callLanguageDecision";
import {
  createIsolatedTestSession
} from "./isolatedTestSession";

export type SimulatedCallRoute = {
  sessionId: string;
  decision: LanguageDecision;
  customerUuid: string;
  staffUuid: string;
  simulationOnly: true;
  translationEnabled: false;
  audioIsolationVerified: false;
};

export function simulateCallRouting(
  sessionId: string,
  customerUuid: string,
  staffUuid: string,
  customerLanguage: CallLanguage,
  staffLanguage: CallLanguage = "ta-IN"
): SimulatedCallRoute {
  const session = createIsolatedTestSession(
    sessionId,
    customerUuid,
    staffUuid
  );

  const decision = decideCallLanguage(
    customerLanguage,
    staffLanguage
  );

  return {
    sessionId: session.sessionId,
    customerUuid: session.customerUuid,
    staffUuid: session.staffUuid,
    decision,
    simulationOnly: true,
    translationEnabled: false,
    audioIsolationVerified: false
  };
}
