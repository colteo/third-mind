import type { LiveConversationTarget, LiveProviderAdapter, LiveFailure, SubmissionReceipt } from '../../ports';
import { CHANNEL, ORIGIN, fixtureConversation, parseReply, type FixtureRequest, type FixtureReply } from './protocol';

export interface FixtureFrame { documentId: string; url: string }
export interface FixtureBrowser {
  frame(tabId: number): Promise<FixtureFrame>;
  send(tabId: number, documentId: string, request: FixtureRequest): Promise<unknown>;
}
export interface JournalEntry { operationId: string; tabId: number; documentId: string; state: 'armed' | 'completed' }
/** A single owner serializes claims. Persist before sending; never delete an uncertain claim. */
export interface FixtureJournal {
  claim(entry: JournalEntry): Promise<boolean>;
  complete(operationId: string): Promise<void>;
}
export function createFixtureJournal(load: () => Promise<JournalEntry[]>, save: (entries: JournalEntry[]) => Promise<void>): FixtureJournal {
  let tail = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    claim: (entry) => serial(async () => {
      const entries = await load();
      if (entries.some((old) => old.operationId === entry.operationId || (old.tabId === entry.tabId && old.state === 'armed'))) return false;
      await save([...entries, entry]);
      return true;
    }),
    complete: (operationId) => serial(async () => {
      await save((await load()).map((entry) => entry.operationId === operationId ? { ...entry, state: 'completed' } : entry));
    }),
  };
}
const failure = (kind: LiveFailure['kind'], message: string, outcome: LiveFailure['outcome'] = 'unknown') =>
  ({ ok: false as const, failure: { kind, message, outcome } });

export function createFixtureAdapter(browser: FixtureBrowser, journal: FixtureJournal, timeoutMs = 2000): LiveProviderAdapter {
  const receipts = new Map<string, { frame: FixtureFrame; receipt: SubmissionReceipt; target: LiveConversationTarget }>();
  const readFrame = (tabId: number) => bounded(browser.frame(tabId), timeoutMs);
  async function exchange(tabId: number, frame: FixtureFrame, request: FixtureRequest): Promise<FixtureReply> {
    const value = await bounded(browser.send(tabId, frame.documentId, request), timeoutMs);
    const reply = parseReply(value);
    if (!reply) throw new Error('invalid-response');
    return reply;
  }
  return {
    // This provider slot is used ONLY in the fixture composition, never in the production registry.
    provider: 'chatgpt', route: { id: 'controlled-fixture', label: 'Local controlled fixture (not ChatGPT)' },
    authorization: { kind: 'authorized', basis: 'Project-owned local test fixture only; no consumer website authorization.' },
    async capabilities(target) {
      const frame = await readFrame(target.tabId).catch(() => null);
      const allowed = frame !== null && fixtureConversation(frame.url) !== false;
      const capability = allowed ? { status: 'available' as const } : { status: 'unavailable' as const, reason: 'Fixture origin only.' };
      return { submission: capability, responseAcquisition: capability };
    },
    async submit(target, submission, { signal }) {
      if (signal.aborted) return failure('target-changed', 'Cancelled before submission.', 'not-performed');
      let frame: FixtureFrame;
      try { frame = await readFrame(target.tabId); }
      catch { return failure('target-changed', 'Tab unavailable.', 'not-performed'); }
      const conversation = fixtureConversation(frame.url);
      if (target.provider !== 'chatgpt' || conversation === false ||
          (target.kind === 'new-chat' ? conversation !== null || target.origin !== ORIGIN : conversation !== target.conversationId)) {
        return failure('target-changed', 'Not the approved fixture target.', 'not-performed');
      }
      try {
        const probe = await exchange(target.tabId, frame, { channel: CHANNEL, version: 1, type: 'probe' });
        const checked = await readFrame(target.tabId);
        if (probe.state !== 'ready' || probe.pageInstanceId !== target.pageInstanceId || probe.conversationId !== conversation || checked.documentId !== frame.documentId || checked.url !== frame.url) {
          return failure('target-changed', 'Document changed before submission.', 'not-performed');
        }
        if (signal.aborted) return failure('target-changed', 'Cancelled before submission.', 'not-performed');
        if (!await journal.claim({ operationId: submission.operationId, tabId: target.tabId, documentId: frame.documentId, state: 'armed' })) {
          return failure('busy', 'Operation already attempted or tab has an unresolved operation. No replay.');
        }
        const ack = await exchange(target.tabId, frame, { channel: CHANNEL, version: 1, type: 'submit', pageInstanceId: target.pageInstanceId, conversationId: conversation, ...submission });
        if (ack.state !== 'accepted' || ack.operationId !== submission.operationId || ack.pageInstanceId !== target.pageInstanceId || ack.submissionId === '') {
          return failure('invalid-response', 'Submission acknowledgement did not correlate.');
        }
        const receipt: SubmissionReceipt = target.kind === 'new-chat'
          ? { kind: 'new-chat', operationId: submission.operationId, pageInstanceId: target.pageInstanceId, submissionId: ack.submissionId }
          : { kind: 'conversation', conversationId: target.conversationId, operationId: submission.operationId, pageInstanceId: target.pageInstanceId, submissionId: ack.submissionId };
        receipts.set(submission.operationId, { frame: { ...frame }, receipt: { ...receipt }, target: { ...target } });
        return { ok: true, receipt };
      } catch (error) { return failure(error instanceof Error && error.message === 'timeout' ? 'timeout' : 'transport-error', 'Submission outcome cannot be established.'); }
    },
    async awaitResponse(target, receipt, { signal }) {
      const saved = receipts.get(receipt.operationId);
      if (!saved || !sameTarget(saved.target, target) ||
          saved.receipt.submissionId !== receipt.submissionId || saved.receipt.pageInstanceId !== receipt.pageInstanceId ||
          saved.receipt.kind !== receipt.kind || (saved.receipt.kind === 'conversation' && (receipt.kind !== 'conversation' || saved.receipt.conversationId !== receipt.conversationId))) return failure('invalid-response', 'Receipt does not belong to this tab and operation.');
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline && !signal.aborted) {
          const before = await readFrame(target.tabId);
          if (before.documentId !== saved.frame.documentId) return failure('target-changed', 'Document navigated.');
          const reply = await exchange(target.tabId, before, { channel: CHANNEL, version: 1, type: 'response', operationId: receipt.operationId, pageInstanceId: receipt.pageInstanceId, submissionId: receipt.submissionId });
          const after = await readFrame(target.tabId);
          if (signal.aborted || Date.now() >= deadline) return failure('timeout', 'Response arrived after cancellation or deadline.');
          const conversationId = fixtureConversation(after.url);
          if (after.documentId !== saved.frame.documentId || fixtureConversation(before.url) === false || conversationId === false ||
              (target.kind === 'conversation' && conversationId !== target.conversationId)) return failure('target-changed', 'Target navigated.');
          if (reply.operationId !== receipt.operationId || reply.pageInstanceId !== receipt.pageInstanceId || reply.submissionId !== receipt.submissionId) return failure('invalid-response', 'Response did not correlate.');
          if (reply.state === 'complete') {
            if (conversationId === null || reply.conversationId !== conversationId || reply.content.length === 0) return failure('invalid-response', 'Conversation identity not established.');
            await journal.complete(receipt.operationId);
            return { ok: true, response: { operationId: receipt.operationId, submissionId: receipt.submissionId, pageInstanceId: receipt.pageInstanceId, conversationId, content: reply.content } };
          }
          if (reply.state !== 'pending') return failure('invalid-response', 'Unexpected response state.');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return failure('timeout', 'Response timed out or was cancelled. No automatic retry.');
      } catch (error) { return failure(error instanceof Error && error.message === 'timeout' ? 'timeout' : 'target-changed', 'Response channel lost; outcome uncertain.'); }
    },
  };
}
function sameTarget(left: LiveConversationTarget, right: LiveConversationTarget): boolean {
  return left.provider === right.provider && left.tabId === right.tabId && left.pageInstanceId === right.pageInstanceId &&
    (left.kind === 'new-chat'
      ? right.kind === 'new-chat' && left.origin === right.origin
      : right.kind === 'conversation' && left.conversationId === right.conversationId);
}
function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}
