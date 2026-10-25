import { browser } from 'wxt/browser';
import type { CheckpointStore, DebateCheckpoint } from '../ports';

export const CHECKPOINT_KEY = 'thirdmind.checkpoint.v1';

/**
 * Operational checkpoint in `chrome.storage.session`.
 *
 * Session storage is held in memory by the browser: it survives service
 * worker restarts but is cleared when the browser exits or the extension is
 * reloaded, and it is not written to disk. This keeps the debate recoverable
 * across MV3 service worker restarts without creating a permanent archive of
 * provider conversations.
 */
export function createSessionCheckpointStore<TSetup>(
  isSetup: (value: unknown) => value is TSetup,
): CheckpointStore<TSetup> {
  return {
    async load() {
      const stored: Record<string, unknown> = await browser.storage.session.get(CHECKPOINT_KEY);
      const value = stored[CHECKPOINT_KEY];
      return isCheckpoint(value, isSetup) ? value : null;
    },
    async save(checkpoint) {
      await browser.storage.session.set({ [CHECKPOINT_KEY]: checkpoint });
    },
    async clear() {
      await browser.storage.session.remove(CHECKPOINT_KEY);
    },
  };
}

/**
 * Structural check of the envelope only. The checkpoint is written exclusively
 * by this extension, so the session payload is not re-validated field by field.
 */
function isCheckpoint<TSetup>(
  value: unknown,
  isSetup: (value: unknown) => value is TSetup,
): value is DebateCheckpoint<TSetup> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof DebateCheckpoint<TSetup>, unknown>>;
  return (
    candidate.version === 1 &&
    typeof candidate.session === 'object' &&
    candidate.session !== null &&
    isSetup(candidate.setup)
  );
}
