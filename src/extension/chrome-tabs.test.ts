import { describe, expect, it } from 'vitest';
import {
  TABS_QUERY_FAILED_REASON,
  TABS_UNAVAILABLE_REASON,
  createChromeTabSource,
  watchTabEvents,
  type TabChangeLike,
  type TabLike,
  type TabsApi,
} from './chrome-tabs';

/** Minimal mock of `chrome.tabs`: listeners are stored so tests can fire events. */
function mockTabsApi(query: () => Promise<readonly TabLike[]>) {
  const listeners = {
    created: [] as ((tab: TabLike) => void)[],
    updated: [] as ((tabId: number, changeInfo: TabChangeLike, tab: TabLike) => void)[],
    removed: [] as ((tabId: number) => void)[],
    replaced: [] as ((added: number, removed: number) => void)[],
  };
  const api: TabsApi = {
    query,
    onCreated: { addListener: (callback) => listeners.created.push(callback) },
    onUpdated: { addListener: (callback) => listeners.updated.push(callback) },
    onRemoved: { addListener: (callback) => listeners.removed.push(callback) },
    onReplaced: { addListener: (callback) => listeners.replaced.push(callback) },
  };
  return { api, listeners };
}

describe('Chrome tab source', () => {
  it('maps tabs and treats a missing URL (no tabs permission) as unavailable', async () => {
    const { api } = mockTabsApi(() =>
      Promise.resolve([
        { id: 1, url: 'https://chatgpt.com/', title: 'ChatGPT' },
        { id: 2, title: 'No URL without the tabs permission' },
        { id: 3, url: '', title: '' },
        { title: 'No id' },
        { id: -1, url: 'https://claude.ai/' },
      ]),
    );
    expect(await createChromeTabSource(api).listTabs()).toEqual({
      ok: true,
      tabs: [
        { tabId: 1, url: 'https://chatgpt.com/', title: 'ChatGPT' },
        { tabId: 2, url: null, title: 'No URL without the tabs permission' },
        { tabId: 3, url: null, title: '' },
      ],
    });
  });

  it('reports a failed query instead of throwing', async () => {
    const error = new Error('Tabs cannot be queried right now');
    const { api } = mockTabsApi(() => Promise.reject(error));
    expect(await createChromeTabSource(api).listTabs()).toEqual({
      ok: false,
      reason: TABS_QUERY_FAILED_REASON,
      cause: error,
    });
  });

  it('reports a missing Tabs API', async () => {
    expect(await createChromeTabSource(undefined).listTabs()).toEqual({ ok: false, reason: TABS_UNAVAILABLE_REASON });
  });
});

describe('Chrome tab events', () => {
  function watch() {
    const { api, listeners } = mockTabsApi(() => Promise.resolve([]));
    const calls: string[] = [];
    watchTabEvents(api, {
      tabChanged: (tabId, url) => calls.push(`changed ${tabId} ${url ?? 'null'}`),
      tabRemoved: (tabId) => calls.push(`removed ${tabId}`),
      rescan: () => calls.push('rescan'),
    });
    return { listeners, calls };
  }

  it('forwards creation, relevant updates, removal and replacement', () => {
    const { listeners, calls } = watch();
    listeners.created.forEach((listener) => {
      listener({ id: 5, url: 'https://claude.ai/new' });
    });
    listeners.updated.forEach((listener) => {
      listener(5, { url: 'https://claude.ai/chat/x' }, { id: 5, url: 'https://claude.ai/chat/x' });
    });
    listeners.removed.forEach((listener) => {
      listener(5);
    });
    listeners.replaced.forEach((listener) => {
      listener(8, 6);
    });
    expect(calls).toEqual(['changed 5 https://claude.ai/new', 'changed 5 https://claude.ai/chat/x', 'removed 5', 'removed 6', 'rescan']);
  });

  it('ignores updates that cannot affect classification', () => {
    const { listeners, calls } = watch();
    listeners.updated.forEach((listener) => {
      listener(5, {}, { id: 5, url: 'https://claude.ai/chat/x' });
    });
    expect(calls).toEqual([]);
  });

  it('registers nothing when the Tabs API is missing', () => {
    expect(() => {
      watchTabEvents(undefined, { tabChanged: () => undefined, tabRemoved: () => undefined, rescan: () => undefined });
    }).not.toThrow();
  });
});
