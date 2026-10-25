import { browser } from 'wxt/browser';
import {
  CONNECTION_SCHEMA_VERSION,
  migrateConnectionRegistryV1,
  parseConnectionRegistry,
  type ConnectionRegistry,
} from '../domain';
import type { ConnectionStore, ConversationRecognizer } from '../ports';

/** Separate from the debate checkpoint key: links and the simulated debate are stored independently. */
export const CONNECTIONS_KEY = 'thirdmind.connections.v2';
/** Phase 2.1 schema (saved conversations only). Read once for migration, then removed. */
export const LEGACY_CONNECTIONS_KEY_V1 = 'thirdmind.connections.v1';

/** What is stored under `CONNECTIONS_KEY`. */
export interface StoredConnections {
  readonly version: typeof CONNECTION_SCHEMA_VERSION;
  readonly registry: ConnectionRegistry;
}

/**
 * Conversation links in `chrome.storage.session`, the same mechanism as the
 * debate checkpoint.
 *
 * Only minimal metadata is stored per provider: tab id, expected provider
 * origin, conversation identity (pending, or a conversation id and canonical
 * conversation URL), connection state and a revision number. No tab titles and
 * no conversation content. A pending new chat stores no conversation id or URL.
 *
 * A Phase 2.1 (version 1) record is migrated on load: each stored URL is
 * classified again with `recognizer`, links that no longer match are dropped,
 * and the old key is removed on the next save. Anything malformed is discarded.
 *
 * Session storage is held in memory by the browser: links survive service
 * worker restarts and side panel closure, but are cleared when the extension
 * is reloaded or updated and when the browser exits. Tab ids are not stable
 * across browser restarts anyway.
 */
export function createSessionConnectionStore(recognizer: ConversationRecognizer): ConnectionStore {
  return {
    async load() {
      const stored: Record<string, unknown> = await browser.storage.session.get([
        CONNECTIONS_KEY,
        LEGACY_CONNECTIONS_KEY_V1,
      ]);
      const current = stored[CONNECTIONS_KEY];
      if (current !== undefined) {
        return parseStoredConnections(current);
      }
      const legacy = stored[LEGACY_CONNECTIONS_KEY_V1];
      return legacy === undefined ? null : migrateConnectionRegistryV1(legacy, (url) => recognizer.recognize(url));
    },
    async save(registry) {
      const value: StoredConnections = { version: CONNECTION_SCHEMA_VERSION, registry };
      await browser.storage.session.set({ [CONNECTIONS_KEY]: value });
      await browser.storage.session.remove(LEGACY_CONNECTIONS_KEY_V1);
    },
  };
}

function parseStoredConnections(value: unknown): ConnectionRegistry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return record.version === CONNECTION_SCHEMA_VERSION ? parseConnectionRegistry(record.registry) : null;
}
