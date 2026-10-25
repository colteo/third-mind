import { createLiveContributionProvider, createSubmissionLocks } from '../../application/live-contribution-provider';
import { createLiveTargetTracker, type LiveTargetRecord } from '../../application/live-target';
import type { LiveDebateSetup } from '../../application/execution-mode';
import type { LiveConversationTarget } from '../../ports';
import { createFixtureAdapter, createFixtureJournal, type JournalEntry, type FixtureBrowser } from './adapter';
import { fixtureChrome as chrome } from './chrome';
import { CHANNEL, ORIGIN, fixtureConversation, parseReply } from './protocol';

const checks: string[] = [];
function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(name);
  checks.push(name);
}
const browser: FixtureBrowser = {
  frame: async (tabId) => {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame) throw new Error('Missing frame');
    return frame;
  },
  send: (tabId, documentId, request) => chrome.tabs.sendMessage(tabId, request, { documentId }),
};
const journal = createFixtureJournal(
  async () => ((await chrome.storage.local.get('operations')).operations ?? []) as JournalEntry[],
  async (operations) => { await chrome.storage.local.set({ operations }); },
);
const adapter = createFixtureAdapter(browser, journal, 2000);
async function probe(tabId: number) {
  const frame = await browser.frame(tabId);
  const reply = parseReply(await browser.send(tabId, frame.documentId, { channel: CHANNEL, version: 1, type: 'probe' }));
  if (!reply) throw new Error('Invalid probe');
  const after = await browser.frame(tabId);
  if (after.documentId !== frame.documentId || after.url !== frame.url) throw new Error('Fixture navigated during probe');
  return reply;
}
async function open(path: string): Promise<LiveConversationTarget> {
  const tab = await chrome.tabs.create({ url: `${ORIGIN}${path}` });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const reply = await probe(tab.id);
      const conversation = fixtureConversation((await browser.frame(tab.id)).url);
      if (conversation === false) throw new Error('Wrong fixture');
      return conversation === null
        ? { kind: 'new-chat', provider: 'chatgpt', origin: ORIGIN, tabId: tab.id, pageInstanceId: reply.pageInstanceId }
        : { kind: 'conversation', provider: 'chatgpt', conversationId: conversation, tabId: tab.id, pageInstanceId: reply.pageInstanceId };
    } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error('Fixture content script unavailable');
}
async function run() {
  const target = await open('/new');
  if (target.kind !== 'new-chat') throw new Error('Expected a new chat');
  const binding = { ...target, linkRevision: 1 };
  const setup: LiveDebateSetup = { mode: 'live', targets: { chatgpt: binding, claude: { ...binding, provider: 'claude' } } };
  const tracker = createLiveTargetTracker({
    load: async () => ((await chrome.storage.local.get('targets')).targets ?? null) as LiveTargetRecord | null,
    save: async (targets) => { await chrome.storage.local.set({ targets }); },
  });
  const provider = createLiveContributionProvider({
    participantId: 'gpt', adapter, setup, targets: tracker, locks: createSubmissionLocks(), responseTimeoutMs: 5000,
    verifyTarget: async (approved) => {
      const observed = await probe(approved.tabId);
      const conversation = fixtureConversation((await browser.frame(approved.tabId)).url);
      if (approved.tabId !== target.tabId || approved.provider !== 'chatgpt' ||
          (approved.kind === 'new-chat'
            ? conversation !== null || observed.pageInstanceId !== approved.pageInstanceId
            : conversation !== approved.conversationId)) {
        return { ok: false, issue: { provider: 'chatgpt', capability: 'transport', code: 'target-changed', message: 'Approved fixture target changed.' } };
      }
      return { ok: true, target: approved.kind === 'new-chat'
        ? { kind: 'new-chat', provider: 'chatgpt', tabId: approved.tabId, origin: approved.origin, pageInstanceId: observed.pageInstanceId }
        : { kind: 'conversation', provider: 'chatgpt', tabId: approved.tabId, conversationId: approved.conversationId, pageInstanceId: observed.pageInstanceId } };
    },
    observeNewChat: async () => {
      const after = await probe(target.tabId);
      const conversationId = fixtureConversation((await browser.frame(target.tabId)).url);
      return typeof conversationId === 'string'
        ? { kind: 'conversation', conversationId, pageInstanceId: after.pageInstanceId, linkRevision: 2 }
        : { kind: 'invalid', reason: 'No conversation observed' };
    },
  });
  const result = await provider.requestContribution({
    operationId: 'fixture:first:1', sessionId: 'fixture-session', participantId: 'gpt', round: 1, maximumRounds: 4,
    phase: 'independent-analysis', topic: 'Controlled browser exchange', constraints: [], priorContributions: [],
    instructions: 'Return the fixture response.', prompt: 'ThirdMind fixture message',
  }, { signal: new AbortController().signal });
  if (!result.ok) throw new Error(`Live contribution failed: ${JSON.stringify(result)}`);
  check(result.content.includes('Fixture response completed'), 'Live contribution port completed a real browser exchange');
  const state = await tracker.forSession('fixture-session', setup).current('chatgpt');
  check(state.kind === 'ready' && state.binding.kind === 'conversation' && state.binding.source === 'first-message', 'First message persisted an identified conversation binding');
  const options = { signal: new AbortController().signal };
  const current: LiveConversationTarget = { kind: 'conversation', provider: 'chatgpt', tabId: target.tabId, pageInstanceId: target.pageInstanceId, conversationId: String(fixtureConversation((await browser.frame(target.tabId)).url)) };
  // Recreate the adapter, retaining only the durable journal. It must not replay.
  const duplicate = await createFixtureAdapter(browser, journal).submit(current, { operationId: 'fixture:first:1', text: 'Duplicate attempt' }, options);
  check(!duplicate.ok && duplicate.failure.outcome === 'unknown', 'Adapter recreation blocks duplicate operation IDs');
  check((await probe(target.tabId)).acceptedCount === 1, 'Fixture accepted exactly one first-message submission');

  const saved = await open('/conversation/existing');
  const submitted = await adapter.submit(saved, { operationId: 'fixture:existing:1', text: 'Existing conversation' }, options);
  check(submitted.ok, 'Saved-conversation submission accepted');
  if (!submitted.ok) throw new Error('No receipt');
  const wrongTab = await adapter.awaitResponse({ ...saved, tabId: target.tabId }, submitted.receipt, options);
  check(!wrongTab.ok && wrongTab.failure.kind === 'invalid-response', 'Receipt cannot be used on a different tab');
  const wrongOperation = await adapter.awaitResponse(saved, { ...submitted.receipt, operationId: 'unrelated-operation' }, options);
  check(!wrongOperation.ok, 'Unrelated operation response rejected');
  const completed = await adapter.awaitResponse(saved, submitted.receipt, options);
  check(completed.ok && completed.response.content === 'Fixture response completed.', 'Streaming content and unrelated stale response ignored until completion');

  const hanging = await open('/conversation/hang');
  const pending = await adapter.submit(hanging, { operationId: 'fixture:timeout:1', text: 'Timeout fixture' }, options);
  if (!pending.ok) throw new Error('Timeout submission not accepted');
  const timeout = await adapter.awaitResponse(hanging, pending.receipt, options);
  check(!timeout.ok && timeout.failure.kind === 'timeout' && timeout.failure.outcome === 'unknown', 'Timeout is uncertain');
  const blocked = await adapter.submit(hanging, { operationId: 'fixture:timeout:2', text: 'Must not send' }, options);
  check(!blocked.ok && blocked.failure.kind === 'busy', 'Unresolved tab blocks another automatic submission');

  const navigating = await open('/conversation/hang');
  const navReceipt = await adapter.submit(navigating, { operationId: 'fixture:navigation:1', text: 'Navigation fixture' }, options);
  if (!navReceipt.ok) throw new Error('Navigation submission not accepted');
  const oldFrame = await browser.frame(navigating.tabId);
  await chrome.tabs.reload(navigating.tabId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await browser.frame(navigating.tabId)).documentId !== oldFrame.documentId) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const navigation = await adapter.awaitResponse(navigating, navReceipt.receipt, options);
  check(!navigation.ok && navigation.failure.outcome === 'unknown', 'Same-URL document reload is uncertain');
  const persisted = (await chrome.storage.local.get('operations')).operations as JournalEntry[];
  check(persisted.filter((entry) => entry.operationId === 'fixture:first:1').length === 1, 'Exactly one durable claim for first operation');
  return { ok: true, checks, firstExchange: result, targetState: state, journal: persisted, userAgent: navigator.userAgent };
}
void run().then(async (report) => {
  document.querySelector('pre')!.textContent = JSON.stringify(report, null, 2);
  await fetch(`${ORIGIN}/report`, { method: 'POST', body: JSON.stringify(report) });
}).catch(async (error: unknown) => {
  const report = { ok: false, checks, error: error instanceof Error ? error.stack : String(error), userAgent: navigator.userAgent };
  document.querySelector('pre')!.textContent = JSON.stringify(report, null, 2);
  await fetch(`${ORIGIN}/report`, { method: 'POST', body: JSON.stringify(report) });
});
