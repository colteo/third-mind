/** Deliberately separate from the production readiness channel. */
export const CHANNEL = 'thirdmind/fixture-exchange';
export const ORIGIN = 'http://127.0.0.1:43115';
export const MAX_TEXT = 32000;
export type FixtureRequest =
  | { channel: typeof CHANNEL; version: 1; type: 'probe' }
  | { channel: typeof CHANNEL; version: 1; type: 'submit'; operationId: string; pageInstanceId: string; conversationId: string | null; text: string }
  | { channel: typeof CHANNEL; version: 1; type: 'response'; operationId: string; pageInstanceId: string; submissionId: string };
export interface FixtureReply {
  channel: typeof CHANNEL;
  version: 1;
  pageInstanceId: string;
  operationId: string;
  submissionId: string;
  state: 'ready' | 'accepted' | 'pending' | 'complete' | 'refused';
  conversationId: string | null;
  content: string;
  acceptedCount: number;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
}
export function fixtureConversation(href: string): string | null | false {
  try {
    const url = new URL(href);
    if (url.origin !== ORIGIN || url.search !== '' || url.hash !== '') return false;
    if (url.pathname === '/new') return null;
    const match = /^\/conversation\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
    return match?.[1] ?? false;
  } catch { return false; }
}
export function parseRequest(raw: unknown): FixtureRequest | null {
  if (!record(raw) || raw.channel !== CHANNEL || raw.version !== 1) return null;
  if (raw.type === 'probe') return { channel: CHANNEL, version: 1, type: 'probe' };
  if (!id(raw.operationId) || !id(raw.pageInstanceId)) return null;
  if (raw.type === 'submit' && (raw.conversationId === null || id(raw.conversationId)) && typeof raw.text === 'string' && raw.text.length > 0 && raw.text.length <= MAX_TEXT) {
    return { channel: CHANNEL, version: 1, type: 'submit', operationId: raw.operationId, pageInstanceId: raw.pageInstanceId, conversationId: raw.conversationId, text: raw.text };
  }
  if (raw.type === 'response' && id(raw.submissionId)) {
    return { channel: CHANNEL, version: 1, type: 'response', operationId: raw.operationId, pageInstanceId: raw.pageInstanceId, submissionId: raw.submissionId };
  }
  return null;
}
export function parseReply(raw: unknown): FixtureReply | null {
  if (!record(raw) || raw.channel !== CHANNEL || raw.version !== 1 || !id(raw.pageInstanceId)) return null;
  if (typeof raw.operationId !== 'string' || (raw.operationId !== '' && !id(raw.operationId)) ||
      typeof raw.submissionId !== 'string' || (raw.submissionId !== '' && !id(raw.submissionId)) ||
      !['ready', 'accepted', 'pending', 'complete', 'refused'].includes(String(raw.state)) ||
      (raw.conversationId !== null && !id(raw.conversationId)) || typeof raw.content !== 'string' || raw.content.length > MAX_TEXT ||
      !Number.isSafeInteger(raw.acceptedCount) || (raw.acceptedCount as number) < 0) return null;
  return { channel: CHANNEL, version: 1, pageInstanceId: raw.pageInstanceId, operationId: raw.operationId,
    submissionId: raw.submissionId, state: raw.state as FixtureReply['state'], conversationId: raw.conversationId, content: raw.content, acceptedCount: raw.acceptedCount as number };
}
