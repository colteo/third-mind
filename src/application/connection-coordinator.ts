import {
  EMPTY_CONNECTION_REGISTRY,
  confirmConversationIdentity,
  linkConversation,
  linkNewChat,
  reconcileRegistry,
  reconnectConversation,
  disconnectConversation,
  type BrowserTabId,
  type ConfirmIdentityRequest,
  type ConnectionChange,
  type ConnectionRegistry,
  type DisconnectRequest,
  type LinkRequest,
  type NewChatLinkRequest,
  type ObservedTab,
  type ReconnectRequest,
  type TabObservation,
} from '../domain';
import type { BrowserTabInfo, ConnectionStore, ConversationRecognizer, TabSource } from '../ports';
import type { RunnerResult } from './debate-runner';

export interface ConnectionCoordinatorDependencies {
  readonly tabs: TabSource;
  readonly recognizer: ConversationRecognizer;
  readonly store: ConnectionStore;
  readonly reportError: (error: unknown) => void;
}

/**
 * Result of the latest tab scan. Only tabs on a supported provider site are
 * kept (`tabs`); every other tab is classified and immediately discarded, so
 * the URLs and titles of unrelated tabs are never retained.
 */
export type TabDiscovery =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly tabs: readonly ObservedTab[]; readonly unavailableTabCount: number }
  | { readonly status: 'failed'; readonly reason: string };

export interface ConnectionsSnapshot {
  readonly registry: ConnectionRegistry;
  readonly discovery: TabDiscovery;
}

export type ConnectionsListener = (snapshot: ConnectionsSnapshot) => void;

export interface ConnectionCoordinator {
  /** Loads stored links and reconciles them with the open tabs, because events may have been missed. */
  initialize(): Promise<void>;
  getSnapshot(): ConnectionsSnapshot;
  subscribe(listener: ConnectionsListener): () => void;
  /** Rescans the tabs and reconciles links. Concurrent requests are coalesced. Never rejects. */
  refresh(): Promise<void>;
  /** A tab was created, navigated or changed. Rescans only if the tab is relevant. Never rejects. */
  tabChanged(tabId: BrowserTabId, url: string | null): Promise<void>;
  /** A tab was closed (or replaced). Idempotent. Never rejects. */
  tabRemoved(tabId: BrowserTabId): Promise<void>;
  link(request: LinkRequest): Promise<RunnerResult>;
  /** Links a new, empty chat with a pending identity. */
  linkNewChat(request: NewChatLinkRequest): Promise<RunnerResult>;
  /** Accepts the conversation a linked new chat's tab now shows, when it could not be attributed automatically. */
  confirmIdentity(request: ConfirmIdentityRequest): Promise<RunnerResult>;
  reconnect(request: ReconnectRequest): Promise<RunnerResult>;
  disconnect(request: DisconnectRequest): Promise<RunnerResult>;
}

/** Tab titles are untrusted display text: control characters removed, whitespace collapsed, length capped. */
export const MAX_TAB_TITLE_LENGTH = 200;

/**
 * Imperative shell around the pure connection model. Like the debate runner,
 * it serializes every change through one queue, so tab events, scans and
 * human commands never interleave. Links are persisted after every change.
 *
 * It never reads page content and never contacts a provider: the only input
 * is the list of open tabs (id, URL, title). Every command rescans first and
 * checks the request against the fresh observation of its tab, so a tab id
 * sent by a client is never trusted on its own.
 */
export function createConnectionCoordinator(deps: ConnectionCoordinatorDependencies): ConnectionCoordinator {
  let registry: ConnectionRegistry = EMPTY_CONNECTION_REGISTRY;
  let discovery: TabDiscovery = { status: 'pending' };
  /** `null` until a scan succeeded in this runtime, and after a failed scan: continuity is not established. */
  let previousTabs: readonly ObservedTab[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let pendingRefresh: Promise<void> | null = null;
  const listeners = new Set<ConnectionsListener>();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch((error: unknown) => {
      deps.reportError(error);
    });
    return result;
  };

  /** For background work triggered by events: failures are already reported by `enqueue`. */
  const enqueueQuietly = (work: () => Promise<void>): Promise<void> =>
    enqueue(work).catch(() => undefined);

  const snapshot = (): ConnectionsSnapshot => ({ registry, discovery });

  const publish = (): void => {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        deps.reportError(error);
      }
    }
  };

  const commit = async (next: ConnectionRegistry): Promise<void> => {
    if (next === registry) {
      return;
    }
    registry = next;
    try {
      await deps.store.save(registry);
    } catch (error) {
      // The in-memory state stays authoritative; it is saved again on the next change.
      deps.reportError(error);
    }
  };

  /**
   * Scans all tabs. Returns the observations, or `null` if the browser could
   * not be queried. The provider tabs of the previous successful scan are
   * kept in `previousTabs` so pending new chats can tell a direct transition
   * from one that happened while ThirdMind was not watching.
   */
  const scan = async (): Promise<ReadonlyMap<BrowserTabId, ObservedTab> | null> => {
    previousTabs = discovery.status === 'ready' ? discovery.tabs : null;
    const result = await deps.tabs.listTabs();
    if (!result.ok) {
      discovery = { status: 'failed', reason: result.reason };
      if (result.cause !== undefined) {
        deps.reportError(result.cause);
      }
      return null;
    }
    const observed = new Map<BrowserTabId, ObservedTab>();
    let unavailableTabCount = 0;
    for (const tab of result.tabs) {
      const observation = observeTab(tab, deps.recognizer);
      observed.set(tab.tabId, observation);
      if (observation.classification.kind === 'unavailable') {
        unavailableTabCount += 1;
      }
    }
    discovery = { status: 'ready', tabs: [...observed.values()].filter(isProviderTab), unavailableTabCount };
    return observed;
  };

  const scanAndReconcile = async (): Promise<ReadonlyMap<BrowserTabId, ObservedTab> | null> => {
    const observed = await scan();
    await commit(
      reconcileRegistry(
        registry,
        (tabId): TabObservation => {
          if (observed === null) {
            return { kind: 'unknown' };
          }
          const tab = observed.get(tabId);
          return tab === undefined ? { kind: 'missing' } : { kind: 'present', tab };
        },
        { previousTabs, currentTabs: discovery.status === 'ready' ? discovery.tabs : [] },
      ),
    );
    publish();
    return observed;
  };

  /** Rescans, then applies a human command against the fresh observation of its tab. */
  const command = (
    tabId: BrowserTabId,
    apply: (tab: ObservedTab | null) => ConnectionChange,
  ): Promise<RunnerResult> =>
    enqueue(async (): Promise<RunnerResult> => {
      const observed = await scanAndReconcile();
      if (observed === null) {
        return { ok: false, reason: 'ThirdMind could not read the open tabs, so the selection was not verified.' };
      }
      return applyChange(apply(observed.get(tabId) ?? null));
    });

  const applyChange = async (change: ConnectionChange): Promise<RunnerResult> => {
    if (!change.ok) {
      return change;
    }
    await commit(change.registry);
    publish();
    return { ok: true };
  };

  const isTracked = (tabId: BrowserTabId): boolean =>
    registry.chatgpt.link?.tabId === tabId ||
    registry.claude.link?.tabId === tabId ||
    (discovery.status === 'ready' && discovery.tabs.some((tab) => tab.tabId === tabId));

  const refresh = (): Promise<void> => {
    if (pendingRefresh === null) {
      pendingRefresh = enqueueQuietly(async () => {
        // Cleared before scanning: an event that arrives during the scan schedules another one.
        pendingRefresh = null;
        await scanAndReconcile();
      });
    }
    return pendingRefresh;
  };

  return {
    initialize: () =>
      enqueue(async () => {
        try {
          registry = (await deps.store.load()) ?? EMPTY_CONNECTION_REGISTRY;
        } catch (error) {
          deps.reportError(error);
          registry = EMPTY_CONNECTION_REGISTRY;
        }
        await scanAndReconcile();
      }),

    getSnapshot: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    refresh,

    tabChanged(tabId, url) {
      const relevant = isTracked(tabId) || (url !== null && deps.recognizer.recognize(url).kind !== 'unsupported');
      return relevant ? refresh() : Promise.resolve();
    },

    tabRemoved: (tabId) =>
      enqueueQuietly(async () => {
        await commit(reconcileRegistry(registry, (id) => (id === tabId ? { kind: 'missing' } : undefined)));
        if (discovery.status === 'ready') {
          discovery = { ...discovery, tabs: discovery.tabs.filter((tab) => tab.tabId !== tabId) };
        }
        publish();
      }),

    link: (request) => command(request.tabId, (tab) => linkConversation(registry, request, tab)),

    linkNewChat: (request) => command(request.tabId, (tab) => linkNewChat(registry, request, tab)),

    confirmIdentity: (request) =>
      command(request.tabId, (tab) => confirmConversationIdentity(registry, request, tab)),

    reconnect: (request) => command(request.tabId, (tab) => reconnectConversation(registry, request, tab)),

    disconnect: (request) => enqueue(() => applyChange(disconnectConversation(registry, request))),
  };
}

function observeTab(tab: BrowserTabInfo, recognizer: ConversationRecognizer): ObservedTab {
  if (tab.url === null) {
    return { tabId: tab.tabId, title: null, classification: { kind: 'unavailable' } };
  }
  const classification = recognizer.recognize(tab.url);
  // Titles of unrelated tabs are not kept.
  const title = classification.kind === 'unsupported' ? null : sanitizeTitle(tab.title);
  return { tabId: tab.tabId, title, classification };
}

function isProviderTab(tab: ObservedTab): boolean {
  const { kind } = tab.classification;
  return kind === 'conversation' || kind === 'new-chat' || kind === 'provider-page';
}

export function sanitizeTitle(title: string | null): string | null {
  if (title === null) {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
  const collapsed = clean.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return null;
  }
  return collapsed.length > MAX_TAB_TITLE_LENGTH ? `${collapsed.slice(0, MAX_TAB_TITLE_LENGTH - 1)}…` : collapsed;
}
