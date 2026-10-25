import type { BrowserTabId } from '../domain';
import type { BrowserTabInfo, TabSource } from '../ports';

/**
 * Chrome Tabs API adapter (Phase 2.1).
 *
 * Only the parts of `chrome.tabs` that ThirdMind uses are described here, so
 * tests can pass a fake object instead of mocking the `browser` global. The
 * real `browser.tabs` satisfies this interface structurally.
 *
 * Reading `url` and `title` of tabs requires the `tabs` permission. Without
 * it, Chrome returns tabs without those fields; they are reported with
 * `url: null` and classified as unavailable, never as conversations.
 */
export interface TabLike {
  readonly id?: number;
  readonly url?: string;
  readonly title?: string;
}

export interface TabChangeLike {
  readonly url?: string;
  readonly title?: string;
  readonly status?: string;
  readonly discarded?: boolean;
}

interface TabEvent<TListener> {
  addListener(callback: TListener): void;
}

export interface TabsApi {
  query(queryInfo: object): Promise<readonly TabLike[]>;
  readonly onCreated: TabEvent<(tab: TabLike) => void>;
  readonly onUpdated: TabEvent<(tabId: number, changeInfo: TabChangeLike, tab: TabLike) => void>;
  readonly onRemoved: TabEvent<(tabId: number) => void>;
  readonly onReplaced: TabEvent<(addedTabId: number, removedTabId: number) => void>;
}

export const TABS_UNAVAILABLE_REASON =
  'Tab access is not available. Check that ThirdMind has the "tabs" permission, then reload the extension.';
export const TABS_QUERY_FAILED_REASON = 'Chrome could not list the open tabs. Use Refresh to try again.';

/** `api` is `undefined` when the browser does not expose `chrome.tabs` to this context. */
export function createChromeTabSource(api: TabsApi | undefined): TabSource {
  return {
    async listTabs() {
      if (api === undefined || typeof api.query !== 'function') {
        return { ok: false, reason: TABS_UNAVAILABLE_REASON };
      }
      try {
        // All tabs of all normal windows. Unrelated tabs are classified and dropped by the coordinator.
        const tabs = await api.query({});
        return { ok: true, tabs: tabs.flatMap(toTabInfo) };
      } catch (error) {
        return { ok: false, reason: TABS_QUERY_FAILED_REASON, cause: error };
      }
    },
  };
}

function toTabInfo(tab: TabLike): BrowserTabInfo[] {
  // Tabs without an id (for example, devtools windows) cannot be linked.
  if (typeof tab.id !== 'number' || !Number.isSafeInteger(tab.id) || tab.id < 0) {
    return [];
  }
  return [
    {
      tabId: tab.id,
      url: typeof tab.url === 'string' && tab.url.length > 0 ? tab.url : null,
      title: typeof tab.title === 'string' ? tab.title : null,
    },
  ];
}

export interface TabEventHandlers {
  readonly tabChanged: (tabId: BrowserTabId, url: string | null) => void;
  readonly tabRemoved: (tabId: BrowserTabId) => void;
  /** Something changed that requires a full rescan. */
  readonly rescan: () => void;
}

/**
 * Forwards tab lifecycle events. Must be called synchronously when the service
 * worker starts, as MV3 requires. Events can still be missed while the worker
 * is suspended, so the coordinator also reconciles on start and on every side
 * panel connection.
 */
export function watchTabEvents(api: TabsApi | undefined, handlers: TabEventHandlers): void {
  if (api === undefined) {
    return;
  }
  api.onCreated.addListener((tab) => {
    if (typeof tab.id === 'number') {
      handlers.tabChanged(tab.id, tab.url ?? null);
    }
  });
  api.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Ignore changes that cannot affect classification or display (favicon, audio, pinning, grouping).
    if (
      changeInfo.url !== undefined ||
      changeInfo.title !== undefined ||
      changeInfo.status !== undefined ||
      changeInfo.discarded !== undefined
    ) {
      handlers.tabChanged(tabId, tab.url ?? null);
    }
  });
  api.onRemoved.addListener((tabId) => {
    handlers.tabRemoved(tabId);
  });
  // Prerendering can swap a tab for a new one. The old tab is gone; the new one is a different tab.
  api.onReplaced.addListener((_addedTabId, removedTabId) => {
    handlers.tabRemoved(removedTabId);
    handlers.rescan();
  });
}
