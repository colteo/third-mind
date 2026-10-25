import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import type { LiveConversationTarget, SubmissionReceipt } from '../../ports';
import { createFixtureAdapter, createFixtureJournal, type FixtureBrowser, type JournalEntry } from './adapter';
import { createFixtureHandler } from './content';
import { CHANNEL, MAX_TEXT, ORIGIN, fixtureConversation, parseReply, parseRequest, type FixtureReply, type FixtureRequest } from './protocol';

const options = () => ({ signal: new AbortController().signal });
const target: LiveConversationTarget = { kind: 'new-chat', provider: 'chatgpt', tabId: 7, origin: ORIGIN, pageInstanceId: 'page-1' };
const envelope = { channel: CHANNEL, version: 1 } as const;
function reply(overrides: Partial<FixtureReply> = {}): FixtureReply {
  return { ...envelope, pageInstanceId: 'page-1', operationId: '', submissionId: '', state: 'ready', conversationId: null, content: '', acceptedCount: 0, ...overrides };
}
function harness() {
  let entries: JournalEntry[] = [];
  const load = async () => structuredClone(entries);
  const save = async (next: JournalEntry[]) => { entries = structuredClone(next); };
  const journal = createFixtureJournal(load, save);
  let frame = { documentId: 'chrome-document-1', url: `${ORIGIN}/new` };
  const send = vi.fn(async (_tabId: number, _documentId: string, request: FixtureRequest): Promise<unknown> => {
    if (request.type === 'probe') return reply({ conversationId: fixtureConversation(frame.url) || null });
    if (request.type === 'submit') {
      frame = { ...frame, url: `${ORIGIN}/conversation/assigned` };
      return reply({ state: 'accepted', operationId: request.operationId, submissionId: 'submission-1' });
    }
    return reply({ state: 'complete', operationId: request.operationId, submissionId: request.submissionId, conversationId: 'assigned', content: 'Complete response' });
  });
  const browser: FixtureBrowser = { frame: async () => frame, send };
  return { browser, journal, send, load, save, navigate: (next: typeof frame) => { frame = next; }, adapter: createFixtureAdapter(browser, journal, 40) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('fixture protocol boundary', () => {
  it('requires exact loopback origin and known paths', () => {
    expect(fixtureConversation(`${ORIGIN}/new`)).toBeNull();
    expect(fixtureConversation(`${ORIGIN}/conversation/assigned`)).toBe('assigned');
    for (const url of ['https://chatgpt.com/new', 'http://127.0.0.1:43116/new', 'http://127.0.0.1.example.net:43115/new', `${ORIGIN}/new?other=1`, `${ORIGIN}/settings`]) expect(fixtureConversation(url)).toBe(false);
  });
  it('validates operation IDs, document tokens, conversation identity and bounded text', () => {
    const request = { ...envelope, type: 'submit', operationId: 'op-1', pageInstanceId: 'page-1', conversationId: null, text: 'Message' };
    expect(parseRequest(request)).toEqual(request);
    for (const patch of [{ version: 2 }, { channel: 'thirdmind/provider-transport' }, { operationId: '' }, { pageInstanceId: null }, { conversationId: 4 }, { text: '' }, { text: 'x'.repeat(MAX_TEXT + 1) }]) expect(parseRequest({ ...request, ...patch })).toBeNull();
    expect(parseReply(reply({ content: 'x'.repeat(MAX_TEXT + 1) }))).toBeNull();
    expect(parseReply({ ...reply(), state: 'made-up' })).toBeNull();
  });
});

describe('durable no-replay journal', () => {
  it('serializes concurrent claims and blocks another operation on an unresolved tab', async () => {
    const h = harness();
    const claim = { operationId: 'op-1', tabId: 7, documentId: 'doc', state: 'armed' as const };
    expect(await Promise.all([h.journal.claim(claim), h.journal.claim(claim)])).toEqual([true, false]);
    expect(await h.journal.claim({ ...claim, operationId: 'op-2' })).toBe(false);
    await h.journal.complete('op-1');
    expect(await createFixtureJournal(h.load, h.save).claim(claim)).toBe(false);
    expect(await h.journal.claim({ ...claim, operationId: 'op-2' })).toBe(true);
  });
  it('sends nothing when persisting a claim fails', async () => {
    const h = harness();
    const adapter = createFixtureAdapter(h.browser, createFixtureJournal(async () => [], async () => { throw new Error('Storage failed'); }));
    expect((await adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options())).ok).toBe(false);
    expect(h.send.mock.calls.map((args) => args[2].type)).toEqual(['probe']);
  });
});

describe('fixture exchange adapter', () => {
  it('correlates the first-message receipt and completed response on the assigned conversation', async () => {
    const h = harness();
    const submitted = await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    expect(submitted).toMatchObject({ ok: true, receipt: { kind: 'new-chat', operationId: 'op-1' } });
    if (!submitted.ok) throw new Error('Missing receipt');
    expect(await h.adapter.awaitResponse(target, submitted.receipt, options())).toMatchObject({ ok: true, response: { operationId: 'op-1', conversationId: 'assigned', content: 'Complete response' } });
    expect(h.send.mock.calls.every((call) => call[0] === 7 && call[1] === 'chrome-document-1')).toBe(true);
    expect((await h.load())[0]?.state).toBe('completed');
  });
  it('never submits to a consumer website or stale document', async () => {
    const h = harness();
    h.navigate({ url: 'https://chatgpt.com/', documentId: 'chrome-document-1' });
    expect(await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options())).toMatchObject({ ok: false, failure: { outcome: 'not-performed' } });
    expect(h.send).not.toHaveBeenCalled();
    h.navigate({ url: `${ORIGIN}/new`, documentId: 'chrome-document-1' });
    expect(await h.adapter.submit({ ...target, pageInstanceId: 'stale' }, { operationId: 'op-1', text: 'Message' }, options())).toMatchObject({ ok: false, failure: { outcome: 'not-performed' } });
    expect(await h.load()).toEqual([]);
  });
  it('blocks replay after adapter recreation', async () => {
    const h = harness();
    await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    h.navigate({ url: `${ORIGIN}/new`, documentId: 'chrome-document-1' });
    const again = await createFixtureAdapter(h.browser, h.journal).submit(target, { operationId: 'op-1', text: 'Message' }, options());
    expect(again).toMatchObject({ ok: false, failure: { outcome: 'unknown' } });
    expect(h.send.mock.calls.filter((call) => call[2].type === 'submit')).toHaveLength(1);
  });
  it.each(['operationId', 'pageInstanceId', 'submissionId', 'conversationId'] as const)('rejects a completed response with a wrong %s', async (field) => {
    const h = harness();
    const submitted = await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    if (!submitted.ok) throw new Error('Missing receipt');
    h.send.mockResolvedValue(reply({ state: 'complete', operationId: 'op-1', pageInstanceId: 'page-1', submissionId: 'submission-1', conversationId: 'assigned', content: 'Reply', [field]: 'wrong' }));
    expect(await h.adapter.awaitResponse(target, submitted.receipt, options())).toMatchObject({ ok: false, failure: { outcome: 'unknown' } });
    expect((await h.load())[0]?.state).toBe('armed');
  });
  it('rejects a receipt used on a different tab', async () => {
    const h = harness();
    const submitted = await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    if (!submitted.ok) throw new Error('Missing receipt');
    expect(await h.adapter.awaitResponse({ ...target, tabId: 8 }, submitted.receipt, options())).toMatchObject({ ok: false, failure: { kind: 'invalid-response' } });
  });
  it('treats a same-URL reload as uncertain', async () => {
    const h = harness();
    const submitted = await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    if (!submitted.ok) throw new Error('Missing receipt');
    h.navigate({ url: `${ORIGIN}/conversation/assigned`, documentId: 'new-document' });
    expect(await h.adapter.awaitResponse(target, submitted.receipt, options())).toMatchObject({ ok: false, failure: { kind: 'target-changed', outcome: 'unknown' } });
  });
  it('does not treat pending streamed text as completion and retains uncertainty on timeout', async () => {
    vi.useFakeTimers();
    const h = harness();
    const submitted = await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    if (!submitted.ok) throw new Error('Missing receipt');
    h.send.mockResolvedValue(reply({ state: 'pending', operationId: 'op-1', submissionId: 'submission-1', conversationId: 'assigned', content: 'Partial' }));
    const pending = h.adapter.awaitResponse(target, submitted.receipt, options());
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
    expect((await h.load())[0]?.state).toBe('armed');
  });
  it('times out an unacknowledged submission without replay', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.send.mockImplementation(async (_tab, _document, request) => request.type === 'probe' ? reply() : new Promise(() => undefined));
    const pending = h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
    expect((await h.load())[0]?.state).toBe('armed');
  });
  it('does not accept completion after cancellation while the response was in flight', async () => {
    const h = harness();
    const controller = new AbortController();
    const submitted = await h.adapter.submit(target, { operationId: 'op-1', text: 'Message' }, options());
    if (!submitted.ok) throw new Error('Missing receipt');
    h.send.mockImplementation(async () => {
      controller.abort();
      return reply({ state: 'complete', operationId: 'op-1', submissionId: 'submission-1', conversationId: 'assigned', content: 'Too late' });
    });
    expect(await h.adapter.awaitResponse(target, submitted.receipt, { signal: controller.signal })).toMatchObject({ ok: false, failure: { kind: 'timeout', outcome: 'unknown' } });
    expect((await h.load())[0]?.state).toBe('armed');
  });
});

describe('fixture DOM adapter', () => {
  function dom() {
    const { document, window } = parseHTML('<html><body><form data-thirdmind-fixture><textarea name="prompt"></textarea></form><div role="textbox" contenteditable="true"></div></body></html>');
    vi.stubGlobal('Event', window.Event);
    const form = document.querySelector('form')!;
    let submissions = 0;
    Object.defineProperty(form, 'requestSubmit', { value: () => {
      submissions += 1;
      const ack = document.createElement('span');
      Object.assign(ack.dataset, { fixtureAck: '', operationId: form.dataset.operationId, submissionId: form.dataset.submissionId });
      document.body.append(ack);
    } });
    const handler = createFixtureHandler(document as unknown as Document, () => `${ORIGIN}/new`, 'page-1');
    return { document, handler, submissions: () => submissions };
  }
  const request = { ...envelope, type: 'submit', operationId: 'op-1', pageInstanceId: 'page-1', conversationId: null, text: 'Synthetic fixture prompt' };
  it('submits once and acknowledges redelivery without a second DOM submission', () => {
    const h = dom();
    const ack = h.handler(request);
    expect(ack?.state).toBe('accepted');
    expect(h.handler(request)?.submissionId).toBe(ack?.submissionId);
    expect(h.handler({ ...request, text: 'Changed' })?.state).toBe('refused');
    expect(h.submissions()).toBe(1);
  });
  it('rejects wrong document and changed conversation before touching the composer', () => {
    const h = dom();
    expect(h.handler({ ...request, pageInstanceId: 'wrong' })?.state).toBe('refused');
    expect(h.handler({ ...request, conversationId: 'other' })?.state).toBe('refused');
    expect(h.submissions()).toBe(0);
  });
  it('only extracts the complete response for this operation and submission', () => {
    const h = dom();
    const ack = h.handler(request)!;
    const receipt: SubmissionReceipt = { kind: 'new-chat', operationId: 'op-1', pageInstanceId: 'page-1', submissionId: ack.submissionId };
    const response = { ...envelope, type: 'response', ...receipt };
    const node = h.document.createElement('article');
    Object.assign(node.dataset, { fixtureResponse: '', operationId: 'other', submissionId: ack.submissionId, state: 'complete' });
    node.textContent = 'Stale text';
    h.document.body.append(node);
    expect(h.handler(response)?.state).toBe('pending');
    node.dataset.operationId = 'op-1';
    node.dataset.state = 'streaming';
    expect(h.handler(response)?.content).toBe('');
    node.dataset.state = 'complete';
    node.textContent = 'Completed synthetic response';
    expect(h.handler(response)).toMatchObject({ state: 'complete', content: 'Completed synthetic response' });
  });
});
