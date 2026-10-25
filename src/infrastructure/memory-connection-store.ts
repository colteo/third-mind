import type { ConnectionRegistry } from '../domain';
import type { ConnectionStore } from '../ports';

/**
 * In-memory connection store for tests. Values are copied through JSON, like
 * `createMemoryCheckpointStore`, so callers never share references with it.
 */
export function createMemoryConnectionStore(initial: ConnectionRegistry | null = null): ConnectionStore & {
  peek(): ConnectionRegistry | null;
  /** Number of completed saves. */
  readonly saves: number;
  /** Makes the next operations fail, to simulate storage errors. */
  failWith(error: Error | null): void;
} {
  let stored: string | null = initial === null ? null : JSON.stringify(initial);
  let saves = 0;
  let failure: Error | null = null;
  const read = (): ConnectionRegistry | null =>
    stored === null ? null : (JSON.parse(stored) as ConnectionRegistry);
  return {
    load: () => (failure === null ? Promise.resolve(read()) : Promise.reject(failure)),
    save: (registry) => {
      if (failure !== null) {
        return Promise.reject(failure);
      }
      stored = JSON.stringify(registry);
      saves += 1;
      return Promise.resolve();
    },
    peek: read,
    get saves() {
      return saves;
    },
    failWith(error) {
      failure = error;
    },
  };
}
