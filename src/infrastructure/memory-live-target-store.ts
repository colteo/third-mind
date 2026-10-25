import type { LiveTargetStore } from '../ports';

/**
 * In-memory live target store. Used by tests and wherever no durable runtime
 * storage is available. Values are copied through JSON, like the memory
 * checkpoint store, so callers never share mutable references with it.
 * `failNextSave` lets tests prove that nothing is submitted when the
 * write-ahead record cannot be written.
 */
export function createMemoryLiveTargetStore<TRecord>(): LiveTargetStore<TRecord> & {
  peek(): TRecord | null;
  failNextSave(): void;
} {
  let stored: string | null = null;
  let failSave = false;
  const read = (): TRecord | null => (stored === null ? null : (JSON.parse(stored) as TRecord));
  return {
    load: () => Promise.resolve(read()),
    save: (record) => {
      if (failSave) {
        failSave = false;
        return Promise.reject(new Error('Storage is unavailable.'));
      }
      stored = JSON.stringify(record);
      return Promise.resolve();
    },
    peek: read,
    failNextSave() {
      failSave = true;
    },
  };
}
