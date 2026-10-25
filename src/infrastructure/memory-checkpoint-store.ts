import type { CheckpointStore, DebateCheckpoint } from '../ports';

/**
 * In-memory checkpoint store. Used by tests and wherever no durable runtime
 * storage is available. Values are copied through JSON so callers cannot
 * share mutable references with the store, which also proves serializability.
 */
export function createMemoryCheckpointStore<TSetup>(): CheckpointStore<TSetup> & {
  peek(): DebateCheckpoint<TSetup> | null;
} {
  let stored: string | null = null;
  const read = (): DebateCheckpoint<TSetup> | null =>
    stored === null ? null : (JSON.parse(stored) as DebateCheckpoint<TSetup>);
  return {
    load: () => Promise.resolve(read()),
    save: (checkpoint) => {
      stored = JSON.stringify(checkpoint);
      return Promise.resolve();
    },
    clear: () => {
      stored = null;
      return Promise.resolve();
    },
    peek: read,
  };
}
