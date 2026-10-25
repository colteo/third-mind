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
      { tabId: 1, url: 'https://chatgpt.com/', title: 'ChatGPT' },
      { tabId: 2, url: null, title: null },
      otherTab(3),
    ]);
    const coordinator = create();
    await coordinator.initialize();
    const snapshot = coordinator.getSnapshot();
    expect(view(coordinator, 'chatgpt')).toMatchObject({ candidates: [], otherPageCount: 1 });
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
      conversationId: GPT_A,
      state: { kind: 'linked' },
      title: 'GPT aaaa',
    });
    expect(view(coordinator, 'chatgpt').candidates.find((c) => c.tabId === 1)?.status).toBe('linked');
    const stored = store.peek();
    expect(stored?.chatgpt.link).toEqual({
      provider: 'chatgpt',
      tabId: 1,
      conversationId: GPT_A,
      canonicalUrl: `https://chatgpt.com/c/${GPT_A}`,
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

  it('refuses to link a provider page or an unknown tab', async () => {
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
    expect(view(coordinator, 'chatgpt').link?.conversationId).toBe(GPT_A);
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
    expect(view(coordinator, 'chatgpt').link?.state).toEqual({ kind: 'disconnected', reason: 'tab-closed' });
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
    expect(view(coordinator, 'chatgpt').link?.state).toEqual({ kind: 'linked' });
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
    expect(gpt.link).toMatchObject({ conversationId: GPT_A, state: { kind: 'stale', reason: 'different-conversation' } });
    // The other conversation is never adopted silently, and its title is not shown as the linked one.
    expect(gpt.link?.title).toBeNull();
    expect(gpt.candidates.find((c) => c.tabId === 1)?.status).toBe('available');
  });

  it('marks the link stale when its tab leaves the provider', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.map((tab) => (tab.tabId === 1 ? otherTab(1) : tab));
    await coordinator.tabChanged(1, 'https://example.com/private');
    expect(view(coordinator, 'chatgpt').link?.state).toEqual({ kind: 'stale', reason: 'left-conversation' });
  });

  it('does not relink automatically when the same conversation reappears', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.filter((tab) => tab.tabId !== 1);
    await coordinator.tabRemoved(1);
    tabs.state.tabs = [...tabs.state.tabs, gptTab(20, GPT_A)];
    await coordinator.tabChanged(20, `https://chatgpt.com/c/${GPT_A}`);
    const gpt = view(coordinator, 'chatgpt');
    expect(gpt.link?.state.kind).toBe('disconnected');
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
    expect(view(coordinator, 'chatgpt').link).toMatchObject({ tabId: 20, state: { kind: 'linked' } });
  });

  it('refuses to reconnect to a different conversation, even in the original tab', async () => {
    const { coordinator, tabs } = await linkedCoordinator();
    tabs.state.tabs = tabs.state.tabs.map((tab) => (tab.tabId === 1 ? gptTab(1, GPT_B, 'GPT aaaa') : tab));
    await coordinator.refresh();
    const revision = view(coordinator, 'chatgpt').revision;
    const result = await coordinator.reconnect({ provider: 'chatgpt', tabId: 1, expectedRevision: revision });
    expect(result.ok).toBe(false);
    expect(view(coordinator, 'chatgpt').link?.state.kind).toBe('stale');
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
    expect(view(restarted, 'chatgpt').link?.state).toEqual({ kind: 'linked' });
  });

  it('reconciles changes that happened while the worker was suspended', async () => {
    const stored = await storedAfterLink();
    const closed = setup([gptTab(2, GPT_B)], stored);
    const afterClose = closed.create();
    await afterClose.initialize();
    expect(view(afterClose, 'chatgpt').link?.state).toEqual({ kind: 'disconnected', reason: 'tab-closed' });
    expect(closed.store.peek()?.chatgpt.link?.state.kind).toBe('disconnected');

    const navigated = setup([gptTab(1, GPT_B)], stored);
    const afterNavigation = navigated.create();
    await afterNavigation.initialize();
    expect(view(afterNavigation, 'chatgpt').link?.state.kind).toBe('stale');
  });

  it('keeps the link but marks it unavailable when the tabs cannot be queried on restart', async () => {
    const context = setup([gptTab(1, GPT_A)], await storedAfterLink());
    context.tabs.state.failure = 'Chrome could not list the open tabs.';
    const restarted = context.create();
    await restarted.initialize();
    expect(view(restarted, 'chatgpt').link?.state).toEqual({ kind: 'unavailable', reason: 'tab-query-failed' });
    context.tabs.state.failure = null;
    await restarted.refresh();
    expect(view(restarted, 'chatgpt').link?.state).toEqual({ kind: 'linked' });
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
    expect(view(coordinator, 'chatgpt').link?.state).toEqual({ kind: 'unavailable', reason: 'tab-query-failed' });
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
