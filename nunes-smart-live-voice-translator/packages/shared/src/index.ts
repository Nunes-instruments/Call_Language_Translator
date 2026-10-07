export type CallMode='WAITING'|'CONNECTING'|'DETECTING_LANGUAGE'|'DIRECT_BYPASS'|'TRANSLATION_ACTIVE'|'TEMPORARY_UNCERTAIN'|'RECONNECTING'|'CALL_ENDING'|'COMPLETED'|'FAILED';
export type Language='ta'|'hi'|'en'|'unknown';
export interface CallSession{callId:string;sessionId:string;staffId:string;staffLanguage:Language;customerLanguage:Language;currentMode:CallMode;startedAt:string;direction:'INBOUND'|'OUTBOUND';providerCallId?:string;languageConfidence:number;status:string}
