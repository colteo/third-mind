import { describe, expect, it } from 'vitest';
import { EMPTY_CONNECTION_REGISTRY, type ConnectionRegistry } from '../domain';
import { createConversationRecognizer } from '../infrastructure/conversation-urls';
import { createMemoryConnectionStore } from '../infrastructure/memory-connection-store';
import type { BrowserTabInfo, TabQueryResult, TabSource } from '../ports';
import { createConnectionCoordinator, MAX_TAB_TITLE_LENGTH, type ConnectionCoordinator } from './connection-coordinator';
import { buildConnectionsView, type ProviderConnectionsView } from './connection-view';

const GPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLAUDE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const gptTab = (tabId: number, id: string, title = `GPT ${id.slice(0, 4)}`): BrowserTabInfo => ({
  tabId,
  url: `https://chatgpt.com/c/${id}`,
  title,
});
const claudeTab = (tabId: number, id: string, title = `Claude ${id.slice(0, 4)}`): BrowserTabInfo => ({
  tabId,
  url: `https://claude.ai/chat/${id}`,
  title,
});
const otherTab = (tabId: number, url = 'https://example.com/private'): BrowserTabInfo => ({
  tabId,
  url,
  title: 'Private page',
});

/** Mocked browser tabs: the test edits `tabs` directly to simulate navigation without events. */
function fakeTabs(initial: BrowserTabInfo[] = []) {
  const state = { tabs: initial, failure: null as string | null, queries: 0 };
  const source: TabSource = {
    listTabs: (): Promise<TabQueryResult> => {
      state.queries += 1;
      return Promise.resolve(
        state.failure !== null
          ? { ok: false, reason: state.failure }
          : { ok: true, tabs: state.tabs.map((tab) => ({ ...tab })) },
      );
    },
  };
  return { source, state };
}

function setup(initialTabs: BrowserTabInfo[] = [], stored: ConnectionRegistry | null = null) {
  const tabs = fakeTabs(initialTabs);
  const store = createMemoryConnectionStore(stored);
  const errors: unknown[] = [];
  const create = (): ConnectionCoordinator =>
    createConnectionCoordinator({
      tabs: tabs.source,
      recognizer: createConversationRecognizer(),
      store,
      reportError: (error) => errors.push(error),
    });
  return { tabs, store, errors, create };
}

function view(coordinator: ConnectionCoordinator, provider: 'chatgpt' | 'claude'): ProviderConnectionsView {
  const result = buildConnectionsView(coordinator.getSnapshot()).providers.find((p) => p.provider === provider);
  if (result === undefined) throw new Error('missing provider');
  return result;
}

async function linkedCoordinator() {
  const context = setup([gptTab(1, GPT_A), gptTab(2, GPT_B), claudeTab(3, CLAUDE_C), otherTab(4)]);
  const coordinator = context.create();
  await coordinator.initialize();
  const result = await coordinator.link({ provider: 'chatgpt', tabId: 1, conversationId: GPT_A, expectedRevision: 0 });
  expect(result).toEqual({ ok: true });
  return { ...context, coordinator };
}

describe('tab discovery', () => {
  it('lists multiple open conversations per provider and never selects one automatically', async () => {
    const { create } = setup([gptTab(1, GPT_A), gptTab(2, GPT_B), claudeTab(3, CLAUDE_C)]);
    const coordinator = create();
    await coordinator.initialize();

    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.candidates.map((c) => [c.tabId, c.conversationId, c.status])).toEqual([
      [1, GPT_A, 'available'],
      [2, GPT_B, 'available'],
    ]);
    expect(gpt.link).toBeNull();
    expect(view(coordinator, 'claude').candidates).toHaveLength(1);
    // A single candidate is not linked automatically either.
    expect(view(coordinator, 'claude').link).toBeNull();
  });

  it('counts provider pages without a conversation and unreadable tabs, and drops unrelated tabs', async () => {
    const { create } = setup([
      { tabId: 1, url: 'https://chatgpt.com/gpts', title: 'ChatGPT' },
      { tabId: 2, url: null, title: null },
      otherTab(3),
    ]);
    const coordinator = create();
    await coordinator.initialize();
    const snapshot = coordinator.getSnapshot();
    expect(view(coordinator, 'chatgpt')).toMatchObject({ candidates: [], newChats: [], otherPageCount: 1 });
    expect(buildConnectionsView(snapshot).unavailableTabCount).toBe(1);
    // Unrelated tabs are not retained, not even their titles.
    expect(JSON.stringify(snapshot)).not.toContain('Private page');
    expect(JSON.stringify(snapshot)).not.toContain('example.com');
  });

  it('sanitizes untrusted tab titles', async () => {
    const { create } = setup([gptTab(1, GPT_A, `  <b>x</b>‮\n${'y'.repeat(500)}`)]);
    const coordinator = create();
    await coordinator.initialize();
    const title = view(coordinator, 'chatgpt').candidates[0]?.title ?? '';
    expect(title.startsWith('<b>x</b> y')).toBe(true);
    expect(title).not.toContain('‮');
    expect(title.length).toBe(MAX_TAB_TITLE_LENGTH);
  });
});

describe('connection confirmation', () => {
  it('links the confirmed conversation and persists only minimal metadata', async () => {
    const { coordinator, store } = await linkedCoordinator();
    expect(view(coordinator, 'chatgpt').link).toEqual({
      tabId: 1,
      identity: { kind: 'saved', conversationId: GPT_A, source: 'selected' },
      status: { kind: 'linked' },
      title: 'GPT aaaa',
    });
    expect(view(coordinator, 'chatgpt').candidates.find((c) => c.tabId === 1)?.status).toBe('linked');
    const stored = store.peek();
    expect(stored?.chatgpt.link).toEqual({
      provider: 'chatgpt',
      origin: 'https://chatgpt.com',
      tabId: 1,
      identity: { kind: 'saved', conversationId: GPT_A, canonicalUrl: `https://chatgpt.com/c/${GPT_A}`, source: 'selected' },
      state: { kind: 'linked' },
    });
    expect(JSON.stringify(stored)).not.toContain('GPT aaaa');
  });

  it('refuses a selection whose tab navigated before confirmation', async () => {
    const { create, tabs } = setup([gptTab(1, GPT_A)]);
    const coordinator = create();
    await coordinator.initialize();
    tabs.state.tabs = [gptTab(1, GPT_B)];
    const result = await coordinator.link({ provider: 'chatgpt', tabId: 1, conversationId: GPT_A, expectedRevision: 0 });
    expect(result.ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link).toBeNull();
  });

  it('refuses to link a new chat or an unknown tab as a saved conversation', async () => {
    const { create } = setup([{ tabId: 1, url: 'https://claude.ai/new', title: 'New chat' }]);
    const coordinator = create();
    await coordinator.initialize();
    expect((await coordinator.link({ provider: 'claude', tabId: 1, conversationId: CLAUDE_C, expectedRevision: 0 })).ok).toBe(false);
    expect((await coordinator.link({ provider: 'claude', tabId: 99, conversationId: CLAUDE_C, expectedRevision: 0 })).ok).toBe(false);
    expect(view(coordinator, 'claude').link).toBeNull();
  });

  it('rejects a stale client instead of overwriting a newer connection', async () => {
    const { coordinator } = await linkedCoordinator();
    // A second panel still shows revision 0 and tries to link another conversation.
    const result = await coordinator.link({ provider: 'chatgpt', tabId: 2, conversationId: GPT_B, expectedRevision: 0 });
    expect(result.ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link?.identity).toMatchObject({ conversationId: GPT_A });
    const disconnect = await coordinator.disconnect({ provider: 'chatgpt', expectedRevision: 0 });
    expect(disconnect.ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link).not.toBeNull();
  });

  it('disconnects on request', async () => {
    const { coordinator, store } = await linkedCoordinator();
    expect(await coordinator.disconnect({ provider: 'chatgpt', expectedRevision: 1 })).toEqual({ ok: true });
    expect(view(coordinator, 'chatgpt').link).toBeNull();
    expect(store.peek()?.chatgpt.link).toBeNull();
  });
});

describe('tab lifecycle', () => {
  it('marks the link disconnected when its tab closes', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.filter((tab) => tab.tabId !== 1);
    await coordinator.tabRemoved(1);
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'disconnected', reason: 'tab-closed' });
  });

  it('handles duplicate removal events without further changes', async () => {
    const { coordinator, store } = await linkedCoordinator();
    await coordinator.tabRemoved(1);
    const revision = view(coordinator, 'chatgpt').revision;
    const saves = store.saves;
    await coordinator.tabRemoved(1);
    await coordinator.tabRemoved(1);
    expect(view(coordinator, 'chatgpt').revision).toBe(revision);
    expect(store.saves).toBe(saves);
  });

  it('coalesces duplicate update events into one scan and stays idempotent', async () => {
    const { coordinator, tabs, store } = await linkedCoordinator();
    const queries = tabs.state.queries;
    const saves = store.saves;
    await Promise.all([
      coordinator.tabChanged(1, `https://chatgpt.com/c/${GPT_A}`),
      coordinator.tabChanged(1, `https://chatgpt.com/c/${GPT_A}`),
      coordinator.tabChanged(1, `https://chatgpt.com/c/${GPT_A}`),
    ]);
    expect(tabs.state.queries).toBe(queries + 1);
    expect(store.saves).toBe(saves);
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'linked' });
  });

  it('does not scan for unrelated tabs', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    const queries = tabs.state.queries;
    await coordinator.tabChanged(50, 'https://example.com/');
    await coordinator.tabChanged(51, null);
    expect(tabs.state.queries).toBe(queries);
  });

  it('discovers a newly opened conversation', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = [...tabs.state.tabs, claudeTab(9, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')];
    await coordinator.tabChanged(9, 'https://claude.ai/chat/dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(view(coordinator, 'claude').candidates.map((c) => c.tabId)).toEqual([3, 9]);
  });

  it('marks the link stale when its tab switches to another conversation of the same provider', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.map((tab) => (tab.tabId === 1 ? gptTab(1, GPT_B, 'Other') : tab));
    await coordinator.tabChanged(1, `https://chatgpt.com/c/${GPT_B}`);
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.link).toMatchObject({
      identity: { conversationId: GPT_A },
      status: { kind: 'stale', reason: 'different-conversation' },
    });
    // The other conversation is never adopted silently, and its title is not shown as the linked one.
    expect(gpt.link?.title).toBeNull();
    expect(gpt.candidates.find((c) => c.tabId === 1)?.status).toBe('available');
  });

  it('marks the link stale when its tab leaves the provider', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.map((tab) => (tab.tabId === 1 ? otherTab(1) : tab));
    await coordinator.tabChanged(1, 'https://example.com/private');
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'stale', reason: 'left-conversation' });
  });

  it('does not relink automatically when the same conversation reappears', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.filter((tab) => tab.tabId !== 1);
    await coordinator.tabRemoved(1);
    tabs.state.tabs = [...tabs.state.tabs, gptTab(20, GPT_A)];
    await coordinator.tabChanged(20, `https://chatgpt.com/c/${GPT_A}`);
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.link?.status.kind).toBe('disconnected');
    expect(gpt.candidates.find((c) => c.tabId === 20)?.status).toBe('reconnectable');
  });
});

describe('explicit reconnection', () => {
  it('reconnects to a tab that shows the same conversation', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = [...tabs.state.tabs.filter((tab) => tab.tabId !== 1), gptTab(20, GPT_A)];
    await coordinator.refresh();
    const revision = view(coordinator, 'chatgpt').revision;
    expect(await coordinator.reconnect({ provider: 'chatgpt', tabId: 20, expectedRevision: revision })).toEqual({ ok: true });
    expect(view(coordinator, 'chatgpt').link).toMatchObject({ tabId: 20, status: { kind: 'linked' } });
  });

  it('refuses to reconnect to a different conversation, even in the original tab', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.map((tab) => (tab.tabId === 1 ? gptTab(1, GPT_B, 'GPT aaaa') : tab));
    await coordinator.refresh();
    const revision = view(coordinator, 'chatgpt').revision;
    const result = await coordinator.reconnect({ provider: 'chatgpt', tabId: 1, expectedRevision: revision });
    expect(result.ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link?.status.kind).toBe('stale');
  });
});

describe('service worker restart and side panel reconnection', () => {
  async function storedAfterLink(): Promise<ConnectionRegistry> {
    const { store } = await linkedCoordinator();
    const stored = store.peek();
    if (stored === null) throw new Error('nothing stored');
    return stored;
  }

  it('restores a link whose tab still shows the conversation', async () => {
    const { create } = setup([gptTab(1, GPT_A)], await storedAfterLink());
    const restarted = create();
    await restarted.initialize();
    expect(view(restarted, 'chatgpt').link?.status).toEqual({ kind: 'linked' });
  });

  it('reconciles changes that happened while the worker was suspended', async () => {
    const stored = await storedAfterLink();
    const closed = setup([gptTab(2, GPT_B)], stored);
    const afterClose = closed.create();
    await afterClose.initialize();
    expect(view(afterClose, 'chatgpt').link?.status).toEqual({ kind: 'disconnected', reason: 'tab-closed' });
    expect(closed.store.peek()?.chatgpt.link?.state.kind).toBe('disconnected');

    const navigated = setup([gptTab(1, GPT_B)], stored);
    const afterNavigation = navigated.create();
    await afterNavigation.initialize();
    expect(view(afterNavigation, 'chatgpt').link?.status.kind).toBe('stale');
  });

  it('keeps the link but marks it unavailable when the tabs cannot be queried on restart', async () => {
    const context = setup([gptTab(1, GPT_A)], await storedAfterLink());
    context.tabs.state.failure = 'Chrome could not list the open tabs.';
    const restarted = context.create();
    await restarted.initialize();
    expect(view(restarted, 'chatgpt').link?.status).toEqual({ kind: 'unavailable', reason: 'tab-query-failed' });
    context.tabs.state.failure = null;
    await restarted.refresh();
    expect(view(restarted, 'chatgpt').link?.status).toEqual({ kind: 'linked' });
  });

  it('starts empty when stored links cannot be loaded', async () => {
    const context = setup([gptTab(1, GPT_A)]);
    context.store.failWith(new Error('storage unavailable'));
    const coordinator = context.create();
    await coordinator.initialize();
    expect(coordinator.getSnapshot().registry).toEqual(EMPTY_CONNECTION_REGISTRY);
    expect(context.errors).toHaveLength(1);
  });

  it('picks up missed changes when a side panel connects and refreshes', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    // No event is delivered (for example, the panel was closed and the event was lost).
    tabs.state.tabs = tabs.state.tabs.map((tab) => (tab.tabId === 1 ? gptTab(1, GPT_B) : tab));
    const received: string[] = [];
    coordinator.subscribe((snapshot) => received.push(snapshot.registry.chatgpt.link?.state.kind ?? 'none'));
    await coordinator.refresh();
    expect(received).toEqual(['stale']);
  });
});

describe('failed tab queries', () => {
  it('reports the failure, keeps links, and refuses unverified selections', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.failure = 'Tab access is not available.';
    await coordinator.refresh();
    const connections = buildConnectionsView(coordinator.getSnapshot());
    expect(connections.discovery).toBe('failed');
    expect(connections.discoveryError).toBe('Tab access is not available.');
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'unavailable', reason: 'tab-query-failed' });
    expect(view(coordinator, 'chatgpt').candidates).toEqual([]);

    const result = await coordinator.link({ provider: 'claude', tabId: 3, conversationId: CLAUDE_C, expectedRevision: 0 });
    expect(result.ok).toBe(false);
  });

  it('keeps working in memory when saving fails', async () => {
    const { coordinator, store, errors } = await linkedCoordinator();
    store.failWith(new Error('quota'));
    expect(await coordinator.disconnect({ provider: 'chatgpt', expectedRevision: 1 })).toEqual({ ok: true });
    expect(view(coordinator, 'chatgpt').link).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// New chats with a pending identity (Phase 2.2A)
// ---------------------------------------------------------------------------

const GPT_NEW = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const gptNewChat = (tabId: number, title = 'ChatGPT'): BrowserTabInfo => ({ tabId, url: 'https://chatgpt.com/', title });
const claudeNewChat = (tabId: number, title = 'Claude'): BrowserTabInfo => ({ tabId, url: 'https://claude.ai/new', title });

/** Moves a tab (or opens it) and delivers the matching tab event. */
async function navigate(
  context: { readonly tabs: ReturnType<typeof fakeTabs> },
  coordinator: ConnectionCoordinator,
  next: BrowserTabInfo,
): Promise<void> {
  const { state } = context.tabs;
  state.tabs = state.tabs.some((tab) => tab.tabId === next.tabId)
    ? state.tabs.map((tab) => (tab.tabId === next.tabId ? next : tab))
    : [...state.tabs, next];
  await coordinator.tabChanged(next.tabId, next.url);
}

async function pendingCoordinator(
  initialTabs: BrowserTabInfo[] = [gptNewChat(5), gptTab(1, GPT_A), claudeTab(3, CLAUDE_C)],
) {
  const context = setup(initialTabs);
  const coordinator = context.create();
  await coordinator.initialize();
  expect(await coordinator.linkNewChat({ provider: 'chatgpt', tabId: 5, expectedRevision: 0 })).toEqual({ ok: true });
  return { ...context, coordinator };
}

describe('new chat discovery', () => {
  it('lists new chats of both providers separately from saved conversations, without selecting any', async () => {
    const { create } = setup([
      gptNewChat(5),
      gptTab(1, GPT_A),
      claudeNewChat(6),
      { tabId: 7, url: 'https://claude.ai/', title: 'Claude' },
    ]);
    const coordinator = create();
    await coordinator.initialize();
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.newChats).toEqual([{ tabId: 5, title: 'ChatGPT', status: 'available' }]);
    expect(gpt.candidates.map((c) => c.tabId)).toEqual([1]);
    expect(gpt.otherPageCount).toBe(0);
    expect(gpt.link).toBeNull();
    expect(view(coordinator, 'claude').newChats.map((c) => c.tabId)).toEqual([6, 7]);
    expect(view(coordinator, 'claude').link).toBeNull();
  });

  it('does not offer temporary chats or spoofed hosts as new chats', async () => {
    const { create } = setup([
      { tabId: 1, url: 'https://chatgpt.com/?temporary-chat=true', title: 'Temporary' },
      { tabId: 2, url: 'https://chatgpt.com.evil.example/', title: 'ChatGPT' },
      { tabId: 3, url: 'http://claude.ai/new', title: 'Claude' },
    ]);
    const coordinator = create();
    await coordinator.initialize();
    expect(view(coordinator, 'chatgpt')).toMatchObject({ newChats: [], otherPageCount: 1 });
    expect(view(coordinator, 'claude').newChats).toEqual([]);
  });

  it('rescans when a tab opens a new chat', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = [...tabs.state.tabs, claudeNewChat(9)];
    await coordinator.tabChanged(9, 'https://claude.ai/new');
    expect(view(coordinator, 'claude').newChats.map((c) => c.tabId)).toEqual([9]);
  });
});

describe('explicit new chat linking', () => {
  it('links the selected new chat as pending and persists no conversation id or URL', async () => {
    const { coordinator, store } = await pendingCoordinator();
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.link).toEqual({
      tabId: 5,
      identity: { kind: 'pending' },
      status: { kind: 'awaiting-identity' },
      title: 'ChatGPT',
    });
    expect(gpt.newChats).toEqual([{ tabId: 5, title: 'ChatGPT', status: 'linked' }]);
    expect(store.peek()?.chatgpt.link).toEqual({
      provider: 'chatgpt',
      origin: 'https://chatgpt.com',
      tabId: 5,
      identity: { kind: 'pending' },
      state: { kind: 'linked' },
    });
  });

  it('refuses a new chat whose tab already moved to a saved conversation before confirmation', async () => {
    const { create, tabs } = setup([gptNewChat(5)]);
    const coordinator = create();
    await coordinator.initialize();
    tabs.state.tabs = [gptTab(5, GPT_NEW)];
    const result = await coordinator.linkNewChat({ provider: 'chatgpt', tabId: 5, expectedRevision: 0 });
    expect(result.ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link).toBeNull();
  });

  it('refuses a tab id that is not open, or that shows another provider', async () => {
    const { create } = setup([claudeNewChat(6)]);
    const coordinator = create();
    await coordinator.initialize();
    expect((await coordinator.linkNewChat({ provider: 'chatgpt', tabId: 99, expectedRevision: 0 })).ok).toBe(false);
    expect((await coordinator.linkNewChat({ provider: 'chatgpt', tabId: 6, expectedRevision: 0 })).ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link).toBeNull();
  });

  it('keeps saved-conversation linking working next to a pending new chat', async () => {
    const { coordinator } = await pendingCoordinator();
    const result = await coordinator.link({ provider: 'claude', tabId: 3, conversationId: CLAUDE_C, expectedRevision: 0 });
    expect(result).toEqual({ ok: true });
    expect(view(coordinator, 'claude').link?.status).toEqual({ kind: 'linked' });
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'awaiting-identity' });
  });
});

describe('identity reconciliation', () => {
  it('records the conversation when the linked tab moves from the new chat to it, without a second connection', async () => {
    const context = await pendingCoordinator();
    const { coordinator, store } = context;
    await navigate(context, coordinator, gptTab(5, GPT_NEW, 'Fresh chat'));
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.revision).toBe(2);
    expect(gpt.link).toEqual({
      tabId: 5,
      identity: { kind: 'saved', conversationId: GPT_NEW, source: 'new-chat' },
      status: { kind: 'linked' },
      title: 'Fresh chat',
    });
    // The same tab is the linked candidate; nothing else was linked.
    expect(gpt.candidates.filter((c) => c.status === 'linked').map((c) => c.tabId)).toEqual([5]);
    expect(gpt.newChats).toEqual([]);
    expect(view(coordinator, 'claude').link).toBeNull();
    expect(store.peek()?.chatgpt.link).toEqual({
      provider: 'chatgpt',
      origin: 'https://chatgpt.com',
      tabId: 5,
      identity: {
        kind: 'saved',
        conversationId: GPT_NEW,
        canonicalUrl: `https://chatgpt.com/c/${GPT_NEW}`,
        source: 'new-chat',
      },
      state: { kind: 'linked' },
    });
  });

  it('records a Claude conversation the same way', async () => {
    const context = setup([claudeNewChat(6)]);
    const coordinator = context.create();
    await coordinator.initialize();
    expect(await coordinator.linkNewChat({ provider: 'claude', tabId: 6, expectedRevision: 0 })).toEqual({ ok: true });
    await navigate(context, coordinator, claudeTab(6, CLAUDE_C));
    expect(view(coordinator, 'claude').link?.identity).toEqual({
      kind: 'saved',
      conversationId: CLAUDE_C,
      source: 'new-chat',
    });
  });

  it('stays pending through reloads and duplicate events while the tab shows the new chat', async () => {
    const { coordinator, store } = await pendingCoordinator();
    const saves = store.saves;
    await Promise.all([coordinator.tabChanged(5, 'https://chatgpt.com/'), coordinator.tabChanged(5, 'https://chatgpt.com/')]);
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'awaiting-identity' });
    expect(store.saves).toBe(saves);
  });

  it('marks the link stale, and adopts nothing, when the tab opens a conversation that was already open elsewhere', async () => {
    const context = await pendingCoordinator();
    const { coordinator } = context;
    // GPT_A has been open in tab 1 since before the new chat was linked.
    await navigate(context, coordinator, gptTab(5, GPT_A));
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.link).toMatchObject({
      identity: { kind: 'pending' },
      status: { kind: 'stale', reason: 'different-conversation' },
    });
    expect(gpt.candidates.every((c) => c.status === 'available')).toBe(true);
  });

  it('marks the link stale when the tab leaves for another site or a non-chat provider page', async () => {
    for (const next of [otherTab(5), { tabId: 5, url: 'https://chatgpt.com/gpts', title: 'GPTs' }, claudeNewChat(5)]) {
      const context = await pendingCoordinator();
      await navigate(context, context.coordinator, next);
      expect(view(context.coordinator, 'chatgpt').link).toMatchObject({
        identity: { kind: 'pending' },
        status: { kind: 'stale', reason: 'left-conversation' },
      });
    }
  });

  it('requires confirmation when the conversation also appears in another tab at the same time', async () => {
    const context = await pendingCoordinator();
    const { coordinator, tabs } = context;
    tabs.state.tabs = [...tabs.state.tabs, gptTab(8, GPT_NEW)];
    await navigate(context, coordinator, gptTab(5, GPT_NEW));
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({
      kind: 'confirmation-required',
      reason: 'open-in-another-tab',
    });
  });

  it('is unaffected by other tabs of the same provider moving to a conversation', async () => {
    const context = await pendingCoordinator([gptNewChat(5), gptNewChat(6)]);
    const { coordinator } = context;
    await navigate(context, coordinator, gptTab(6, GPT_B));
    expect(view(coordinator, 'chatgpt').link).toMatchObject({ tabId: 5, status: { kind: 'awaiting-identity' } });
    await navigate(context, coordinator, gptTab(5, GPT_NEW));
    expect(view(coordinator, 'chatgpt').link).toMatchObject({
      tabId: 5,
      identity: { kind: 'saved', conversationId: GPT_NEW, source: 'new-chat' },
    });
  });

  it('never replaces the recorded conversation when the tab later shows another one', async () => {
    const context = await pendingCoordinator();
    const { coordinator } = context;
    await navigate(context, coordinator, gptTab(5, GPT_NEW));
    await navigate(context, coordinator, gptTab(5, GPT_B));
    expect(view(coordinator, 'chatgpt').link).toMatchObject({
      identity: { kind: 'saved', conversationId: GPT_NEW },
      status: { kind: 'stale', reason: 'different-conversation' },
    });
  });
});

describe('closing and reopening a pending new chat', () => {
  it('disconnects when the tab closes and never links a reopened tab automatically', async () => {
    const context = await pendingCoordinator();
    const { coordinator, tabs } = context;
    tabs.state.tabs = tabs.state.tabs.filter((tab) => tab.tabId !== 5);
    await coordinator.tabRemoved(5);
    expect(view(coordinator, 'chatgpt').link).toMatchObject({
      identity: { kind: 'pending' },
      status: { kind: 'disconnected', reason: 'tab-closed' },
    });

    // The provider is opened again in a new tab (for example, with "Reopen closed tab").
    await navigate(context, coordinator, gptNewChat(15));
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.link?.status.kind).toBe('disconnected');
    expect(gpt.newChats).toEqual([{ tabId: 15, title: 'ChatGPT', status: 'available' }]);

    // A reopened tab that shows a saved conversation cannot be tied to the pending chat either.
    await navigate(context, coordinator, gptTab(15, GPT_NEW));
    expect(view(coordinator, 'chatgpt').candidates.find((c) => c.tabId === 15)?.status).toBe('available');
    const revision = view(coordinator, 'chatgpt').revision;
    expect((await coordinator.reconnect({ provider: 'chatgpt', tabId: 15, expectedRevision: revision })).ok).toBe(false);

    // The human can link the reopened tab explicitly instead.
    const result = await coordinator.link({
      provider: 'chatgpt',
      tabId: 15,
      conversationId: GPT_NEW,
      expectedRevision: revision,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('service worker recovery of new chats', () => {
  async function storedPending(): Promise<ConnectionRegistry> {
    const { store } = await pendingCoordinator();
    const stored = store.peek();
    if (stored === null) throw new Error('nothing stored');
    return stored;
  }

  it('restores a pending link whose tab still shows the new chat, then records the conversation directly', async () => {
    const context = setup([gptNewChat(5)], await storedPending());
    const restarted = context.create();
    await restarted.initialize();
    expect(view(restarted, 'chatgpt').link?.status).toEqual({ kind: 'awaiting-identity' });
    // Continuity is re-established by the first scan after the restart.
    await navigate(context, restarted, gptTab(5, GPT_NEW));
    expect(view(restarted, 'chatgpt').link?.identity).toEqual({
      kind: 'saved',
      conversationId: GPT_NEW,
      source: 'new-chat',
    });
  });

  it('requires confirmation when the conversation appeared while the worker was stopped', async () => {
    const context = setup([gptTab(5, GPT_NEW)], await storedPending());
    const restarted = context.create();
    await restarted.initialize();
    const gpt = view(restarted, 'chatgpt');
    expect(gpt.link).toMatchObject({
      tabId: 5,
      identity: { kind: 'unconfirmed', conversationId: GPT_NEW, reason: 'observation-gap' },
      status: { kind: 'confirmation-required', reason: 'observation-gap' },
    });
    expect(gpt.candidates).toEqual([
      { tabId: 5, conversationId: GPT_NEW, title: `GPT ${GPT_NEW.slice(0, 4)}`, status: 'linked' },
    ]);

    const result = await restarted.confirmIdentity({
      provider: 'chatgpt',
      tabId: 5,
      conversationId: GPT_NEW,
      expectedRevision: gpt.revision,
    });
    expect(result).toEqual({ ok: true });
    expect(view(restarted, 'chatgpt').link).toMatchObject({
      identity: { kind: 'saved', conversationId: GPT_NEW, source: 'confirmed' },
      status: { kind: 'linked' },
    });
    expect(context.store.peek()?.chatgpt.link?.identity).toMatchObject({ kind: 'saved', source: 'confirmed' });
  });

  it('never resolves a reused tab id silently', async () => {
    // The stored pending tab id 5 now belongs to a tab showing some other conversation.
    const context = setup([gptTab(5, GPT_B, 'Someone else')], await storedPending());
    const restarted = context.create();
    await restarted.initialize();
    expect(view(restarted, 'chatgpt').link?.identity).toMatchObject({ kind: 'unconfirmed', conversationId: GPT_B });
  });

  it('marks the pending link disconnected when its tab disappeared while the worker was stopped', async () => {
    const context = setup([gptNewChat(9)], await storedPending());
    const restarted = context.create();
    await restarted.initialize();
    expect(view(restarted, 'chatgpt').link?.status).toEqual({ kind: 'disconnected', reason: 'tab-closed' });
    expect(view(restarted, 'chatgpt').newChats).toEqual([{ tabId: 9, title: 'ChatGPT', status: 'available' }]);
  });

  it('requires confirmation after a failed tab query, even without a restart', async () => {
    const context = await pendingCoordinator();
    const { coordinator, tabs } = context;
    tabs.state.failure = 'Chrome could not list the open tabs.';
    await coordinator.refresh();
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'unavailable', reason: 'tab-query-failed' });
    tabs.state.failure = null;
    await navigate(context, coordinator, gptTab(5, GPT_NEW));
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({
      kind: 'confirmation-required',
      reason: 'observation-gap',
    });
  });
});

describe('stale identity confirmation requests', () => {
  async function awaitingConfirmation() {
    const { store } = await pendingCoordinator();
    const context = setup([gptTab(5, GPT_NEW), gptTab(6, GPT_B)], store.peek());
    const coordinator = context.create();
    await coordinator.initialize();
    expect(view(coordinator, 'chatgpt').link?.identity.kind).toBe('unconfirmed');
    return { ...context, coordinator, revision: view(coordinator, 'chatgpt').revision };
  }

  it('refuses a different tab, a different conversation, another provider or an outdated revision', async () => {
    const { coordinator, revision } = await awaitingConfirmation();
    const confirm = (tabId: number, conversationId: string, expectedRevision: number, provider: 'chatgpt' | 'claude' = 'chatgpt') =>
      coordinator.confirmIdentity({ provider, tabId, conversationId, expectedRevision });
    expect((await confirm(6, GPT_B, revision)).ok).toBe(false);
    expect((await confirm(5, GPT_B, revision)).ok).toBe(false);
    expect((await confirm(5, GPT_NEW, revision - 1)).ok).toBe(false);
    expect((await confirm(5, GPT_NEW, 0, 'claude')).ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link?.identity.kind).toBe('unconfirmed');
  });

  it('refuses when the tab moved away after the question was shown', async () => {
    const { coordinator, revision, tabs } = await awaitingConfirmation();
    // No event is delivered; the command's own rescan must notice the move.
    tabs.state.tabs = [gptTab(5, GPT_B), gptTab(6, GPT_B)];
    const result = await coordinator.confirmIdentity({
      provider: 'chatgpt',
      tabId: 5,
      conversationId: GPT_NEW,
      expectedRevision: revision,
    });
    expect(result.ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link?.status).toEqual({ kind: 'stale', reason: 'different-conversation' });
  });
});
