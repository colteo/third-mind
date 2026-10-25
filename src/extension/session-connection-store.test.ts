import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CONNECTION_REGISTRY, type ConnectionRegistry } from '../domain';
import { createConversationRecognizer } from '../infrastructure/conversation-urls';
import { CHECKPOINT_KEY } from './session-checkpoint-store';
import {
  CONNECTIONS_KEY,
  LEGACY_CONNECTIONS_KEY_V1,
  createSessionConnectionStore,
  type StoredConnections,
} from './session-connection-store';

/** Mocked `chrome.storage.session`. `vi.mock` is hoisted above the imports, so both stores see the mock. */
const sessionData = vi.hoisted(() => new Map<string, unknown>());

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        get: (keys: string | string[]) => {
          const result: Record<string, unknown> = {};
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            if (sessionData.has(key)) result[key] = structuredClone(sessionData.get(key));
          }
          return Promise.resolve(result);
        },
        set: (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) sessionData.set(key, structuredClone(value));
          return Promise.resolve();
        },
        remove: (key: string) => {
          sessionData.delete(key);
          return Promise.resolve();
        },
      },
    },
  },
}));

const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const LINKED: ConnectionRegistry = {
  ...EMPTY_CONNECTION_REGISTRY,
  claude: {
    revision: 1,
    link: {
      provider: 'claude',
      origin: 'https://claude.ai',
      tabId: 4,
      identity: { kind: 'saved', conversationId: C, canonicalUrl: `https://claude.ai/chat/${C}`, source: 'selected' },
      state: { kind: 'linked' },
    },
  },
};

const PENDING: ConnectionRegistry = {
  ...EMPTY_CONNECTION_REGISTRY,
  chatgpt: {
    revision: 1,
    link: {
      provider: 'chatgpt',
      origin: 'https://chatgpt.com',
      tabId: 5,
      identity: { kind: 'pending' },
      state: { kind: 'linked' },
    },
  },
};

const createStore = () => createSessionConnectionStore(createConversationRecognizer());

describe('session connection store', () => {
  beforeEach(() => {
    sessionData.clear();
  });

  it('round-trips saved and pending links in a versioned record', async () => {
    const store = createStore();
    expect(await store.load()).toBeNull();
    await store.save(LINKED);
    expect(await store.load()).toEqual(LINKED);
    expect(sessionData.get(CONNECTIONS_KEY)).toEqual({ version: 2, registry: LINKED });
    await store.save(PENDING);
    expect(await store.load()).toEqual(PENDING);
  });

  it('discards a corrupted record instead of trusting it', async () => {
    sessionData.set(CONNECTIONS_KEY, { version: 2, registry: { chatgpt: { revision: 'x' } } });
    expect(await createStore().load()).toBeNull();
  });

  it('discards a record with an unknown schema version', async () => {
    sessionData.set(CONNECTIONS_KEY, { version: 3, registry: LINKED });
    expect(await createStore().load()).toBeNull();
    sessionData.set(CONNECTIONS_KEY, LINKED);
    expect(await createStore().load()).toBeNull();
  });
});

describe('migration from the Phase 2.1 schema', () => {
  beforeEach(() => {
    sessionData.clear();
  });

  const v1 = (canonicalUrl: string) => ({
    chatgpt: { revision: 0, link: null },
    claude: {
      revision: 1,
      link: { provider: 'claude', tabId: 4, conversationId: C, canonicalUrl, state: { kind: 'linked' } },
    },
  });

  it('migrates a version 1 record and removes the old key on the next save', async () => {
    sessionData.set(LEGACY_CONNECTIONS_KEY_V1, v1(`https://claude.ai/chat/${C}`));
    const store = createStore();
    const loaded = await store.load();
    expect(loaded).toEqual(LINKED);
    if (loaded === null) throw new Error('not migrated');
    await store.save(loaded);
    expect([...sessionData.keys()]).toEqual([CONNECTIONS_KEY]);
  });

  it('drops a migrated link whose stored URL is not a recognized conversation', async () => {
    sessionData.set(LEGACY_CONNECTIONS_KEY_V1, v1(`https://claude.ai.evil.example/chat/${C}`));
    expect((await createStore().load())?.claude).toEqual({ revision: 2, link: null });
  });

  it('prefers the current record over a leftover version 1 record', async () => {
    sessionData.set(LEGACY_CONNECTIONS_KEY_V1, v1(`https://claude.ai/chat/${C}`));
    sessionData.set(CONNECTIONS_KEY, { version: 2, registry: PENDING } satisfies StoredConnections);
    expect(await createStore().load()).toEqual(PENDING);
  });
});

describe('isolation between the simulated debate and conversation links', () => {
  beforeEach(() => {
    sessionData.clear();
  });

  it('stores links under their own key, never inside the debate checkpoint', async () => {
    expect(CONNECTIONS_KEY).not.toBe(CHECKPOINT_KEY);
    await createStore().save(LINKED);
    expect([...sessionData.keys()]).toEqual([CONNECTIONS_KEY]);
  });

  it('stores only minimal link metadata', async () => {
    await createStore().save(LINKED);
    const stored = sessionData.get(CONNECTIONS_KEY) as StoredConnections;
    expect(Object.keys(stored.registry.claude.link ?? {}).sort()).toEqual(['identity', 'origin', 'provider', 'state', 'tabId']);
    expect(Object.keys(stored.registry.claude.link?.identity ?? {}).sort()).toEqual([
      'canonicalUrl',
      'conversationId',
      'kind',
      'source',
    ]);
  });

  it('stores no conversation id or URL for a pending new chat', async () => {
    await createStore().save(PENDING);
    const stored = sessionData.get(CONNECTIONS_KEY) as StoredConnections;
    expect(stored.registry.chatgpt.link?.identity).toEqual({ kind: 'pending' });
  });
});
