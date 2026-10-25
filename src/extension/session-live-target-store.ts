import { browser } from 'wxt/browser';
import { parseLiveTargetRecord, type LiveTargetRecord } from '../application';
import type { LiveTargetStore } from '../ports';

export const LIVE_TARGETS_KEY = 'thirdmind.live-targets.v1';

/**
 * Live target record in `chrome.storage.session`, next to the debate
 * checkpoint and with the same lifetime: it survives service worker restarts
 * (so the write-ahead record of a new chat's first message is found again)
 * and is cleared when the browser exits or the extension is reloaded. It
 * holds tab ids, conversation ids and page instance ids only.
 */
export function createSessionLiveTargetStore(): LiveTargetStore<LiveTargetRecord> {
  return {
    async load() {
      const stored: Record<string, unknown> = await browser.storage.session.get(LIVE_TARGETS_KEY);
      return parseLiveTargetRecord(stored[LIVE_TARGETS_KEY]);
    },
    async save(record) {
      await browser.storage.session.set({ [LIVE_TARGETS_KEY]: record });
    },
  };
}
