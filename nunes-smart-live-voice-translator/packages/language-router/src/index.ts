export type RouterMode='DIRECT_BYPASS'|'TRANSLATION_ACTIVE'|'TEMPORARY_UNCERTAIN';
export function decideMode(staff:'ta'|'hi',customer:'ta'|'hi'|'unknown',confidence:number,threshold=.85):RouterMode{if(customer==='unknown'||confidence<threshold)return'TEMPORARY_UNCERTAIN';return staff===customer?'DIRECT_BYPASS':'TRANSLATION_ACTIVE'}
