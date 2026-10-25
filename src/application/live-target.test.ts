import { describe, expect, it } from 'vitest';
import { createMemoryLiveTargetStore } from '../infrastructure/memory-live-target-store';
import type { LiveResponse, SubmissionReceipt } from '../ports';
import type { LiveDebateSetup, NewChatBinding, SavedConversationBinding } from './execution-mode';
import {
  createLiveTargetTracker,
  parseLiveTargetRecord,
  reconcileFirstMessage,
  resolveFirstMessageState,
  type LiveTargetRecord,
  type NewChatObservation,
} from './live-target';

const CREATED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPERATION = 'session-1:round-1:gpt:attempt-1';

const newChat: NewChatBinding = {
  kind: 'new-chat',
  provider: 'chatgpt',
  tabId: 11,
  origin: 'https://chatgpt.com',
  pageInstanceId: 'page-1',
  linkRevision: 1,
};
const saved: SavedConversationBinding = {
  kind: 'conversation',
  provider: 'claude',
  tabId: 22,
  conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  linkRevision: 1,
  source: 'linked',
};
const setup: LiveDebateSetup = { mode: 'live', targets: { chatgpt: newChat, claude: saved } };

const receipt: SubmissionReceipt = { kind: 'new-chat', operationId: OPERATION, pageInstanceId: 'page-1', submissionId: 's-1' };
const response: LiveResponse = {
  operationId: OPERATION,
  submissionId: 's-1',
  pageInstanceId: 'page-1',
  conversationId: CREATED,
  content: 'Answer',
};
const moved: NewChatObservation = { kind: 'conversation', conversationId: CREATED, pageInstanceId: 'page-1', linkRevision: 2 };

describe('first-message reconciliation', () => {
  it('binds the conversation when adapter, document and tab agree', () => {
    expect(reconcileFirstMessage(newChat, OPERATION, receipt, response, moved)).toEqual({
      ok: true,
      binding: { kind: 'conversation', provider: 'chatgpt', tabId: 11, conversationId: CREATED, linkRevision: 2, source: 'first-message' },
    });
  });

  it.each<[string, Partial<{ receipt: SubmissionReceipt; response: LiveResponse; observation: NewChatObservation; operation: string }>]>([
    ['the receipt is for a saved conversation', { receipt: { ...receipt, kind: 'conversation', conversationId: CREATED } }],
    ['the receipt belongs to another operation', { receipt: { ...receipt, operationId: 'other' } }],
    ['the receipt comes from another document', { receipt: { ...receipt, pageInstanceId: 'page-0' } }],
    ['the response belongs to another submission', { response: { ...response, submissionId: 's-2' } }],
    ['the response comes from another document', { response: { ...response, pageInstanceId: 'page-2' } }],
    ['the reported conversation id is invalid', { response: { ...response, conversationId: '' } }],
    ['the operation differs', { operation: 'other' }],
    ['the tab still shows the new chat', { observation: { kind: 'new-chat', pageInstanceId: 'page-1', linkRevision: 1 } }],
    ['the tab loaded another document', { observation: { ...moved, pageInstanceId: 'page-2' } }],
    ['the tab shows another conversation', { observation: { ...moved, conversationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }],
    ['the target is invalid', { observation: { kind: 'invalid', reason: 'The linked ChatGPT tab was closed.' } }],
  ])('leaves the identity unresolved when %s', (_name, overrides) => {
    const result = reconcileFirstMessage(
      newChat,
      overrides.operation ?? OPERATION,
      overrides.receipt ?? receipt,
      overrides.response ?? response,
      overrides.observation ?? moved,
    );
    expect(result.ok).toBe(false);
  });
});

describe('explicit first-message recovery', () => {
  const pending = { kind: 'first-message', binding: newChat, operationId: OPERATION } as const;

  it('binds the conversation the tab shows, or keeps the new chat the tab still shows', () => {
    expect(resolveFirstMessageState(pending, { kind: 'bind-conversation', conversationId: CREATED }, moved)).toMatchObject({
      ok: true,
      state: { kind: 'ready', binding: { kind: 'conversation', conversationId: CREATED, source: 'recovered' } },
    });
    expect(
      resolveFirstMessageState(pending, { kind: 'keep-new-chat' }, { kind: 'new-chat', pageInstanceId: 'page-9', linkRevision: 4 }),
    ).toEqual({ ok: true, state: { kind: 'ready', binding: { ...newChat, pageInstanceId: 'page-9', linkRevision: 4 } } });
  });

  it('refuses decisions that contradict the tab, or when nothing is unresolved', () => {
    expect(resolveFirstMessageState(pending, { kind: 'keep-new-chat' }, moved).ok).toBe(false);
    expect(resolveFirstMessageState(pending, { kind: 'bind-conversation', conversationId: 'x' }, moved).ok).toBe(false);
    expect(
      resolveFirstMessageState(pending, { kind: 'bind-conversation', conversationId: CREATED }, { kind: 'invalid', reason: 'Closed.' }),
    ).toEqual({ ok: false, reason: 'Closed.' });
    expect(resolveFirstMessageState({ kind: 'ready', binding: newChat }, { kind: 'keep-new-chat' }, moved).ok).toBe(false);
  });
});

describe('live target tracker', () => {
  it('starts from the setup and persists every change for the session', async () => {
    const store = createMemoryLiveTargetStore<LiveTargetRecord>();
    const targets = createLiveTargetTracker(store).forSession('session-1', setup);
    expect(await targets.current('chatgpt')).toEqual({ kind: 'ready', binding: newChat });
    expect(store.peek()).toBeNull();

    expect(await targets.armFirstMessage(newChat, OPERATION)).toEqual({ ok: true });
    expect(store.peek()).toMatchObject({ sessionId: 'session-1', targets: { chatgpt: { kind: 'first-message', operationId: OPERATION } } });
    expect(targets.isFirstMessageInProgress('chatgpt')).toBe(true);
    // A second first message is refused while one is recorded.
    expect((await targets.armFirstMessage(newChat, 'another')).ok).toBe(false);

    const bound: SavedConversationBinding = { ...saved, provider: 'chatgpt', tabId: 11, conversationId: CREATED, source: 'first-message' };
    expect((await targets.bindFirstMessage('another', bound)).ok).toBe(false);
    expect(await targets.bindFirstMessage(OPERATION, bound)).toEqual({ ok: true });
    targets.settleFirstMessage('chatgpt');
    expect(targets.isFirstMessageInProgress('chatgpt')).toBe(false);

    // A restarted worker reads the same record.
    const restarted = createLiveTargetTracker(store).forSession('session-1', setup);
    expect(await restarted.current('chatgpt')).toEqual({ kind: 'ready', binding: bound });
    expect(restarted.isFirstMessageInProgress('chatgpt')).toBe(false);
    // Another session ignores it.
    expect(await createLiveTargetTracker(store).forSession('session-2', setup).current('chatgpt')).toEqual({ kind: 'ready', binding: newChat });
  });

  it('refuses to arm a binding that is not the current one', async () => {
    const targets = createLiveTargetTracker(createMemoryLiveTargetStore<LiveTargetRecord>()).forSession('session-1', setup);
    expect((await targets.armFirstMessage({ ...newChat, pageInstanceId: 'page-2' }, OPERATION)).ok).toBe(false);
  });

  it('withdraws only the matching first message', async () => {
    const targets = createLiveTargetTracker(createMemoryLiveTargetStore<LiveTargetRecord>()).forSession('session-1', setup);
    await targets.armFirstMessage(newChat, OPERATION);
    expect((await targets.withdrawFirstMessage('chatgpt', 'other')).ok).toBe(false);
    expect(await targets.withdrawFirstMessage('chatgpt', OPERATION)).toEqual({ ok: true });
    expect(await targets.current('chatgpt')).toEqual({ kind: 'ready', binding: newChat });
  });

  it('parses stored records strictly', () => {
    const record: LiveTargetRecord = {
      version: 1,
      sessionId: 'session-1',
      targets: { chatgpt: { kind: 'first-message', binding: newChat, operationId: OPERATION }, claude: { kind: 'ready', binding: saved } },
    };
    expect(parseLiveTargetRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(parseLiveTargetRecord({ ...record, version: 2 })).toBeNull();
    // A first message can only be recorded for a new chat.
    expect(
      parseLiveTargetRecord({ ...record, targets: { ...record.targets, claude: { kind: 'first-message', binding: saved, operationId: 'x' } } }),
    ).toBeNull();
    expect(parseLiveTargetRecord({ ...record, targets: { ...record.targets, chatgpt: { kind: 'ready', binding: { ...newChat, provider: 'claude' } } } })).toBeNull();
    expect(parseLiveTargetRecord(null)).toBeNull();
  });
});
