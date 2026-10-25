import { browser } from 'wxt/browser';
import { parseConnectionRegistry } from '../domain';
import type { ConnectionStore } from '../ports';

/** Separate from the debate checkpoint key: links and the simulated debate are stored independently. */
export const CONNECTIONS_KEY = 'thirdmind.connections.v1';

/**
 * Conversation links in `chrome.storage.session`, the same mechanism as the
 * debate checkpoint.
 *
 * Only minimal metadata is stored per provider: tab id, conversation id,
 * canonical conversation URL, connection state and a revision number. No tab
 * titles and no conversation content.
 *
 * Session storage is held in memory by the browser: links survive service
 * worker restarts and side panel closure, but are cleared when the extension
 * is reloaded or updated and when the browser exits. Tab ids are not stable
 * across browser restarts anyway.
 */
export function createSessionConnectionStore(): ConnectionStore {
  return {
    async load() {
      const stored: Record<string, unknown> = await browser.storage.session.get(CONNECTIONS_KEY);
      const value = stored[CONNECTIONS_KEY];
      return value === undefined ? null : parseConnectionRegistry(value);
    },
    async save(registry) {
      await browser.storage.session.set({ [CONNECTIONS_KEY]: registry });
    },
  };
}
