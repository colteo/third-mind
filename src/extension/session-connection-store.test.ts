import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CONNECTION_REGISTRY, type ConnectionRegistry } from '../domain';
import { CHECKPOINT_KEY } from './session-checkpoint-store';
import { CONNECTIONS_KEY, createSessionConnectionStore } from './session-connection-store';

/** Mocked `chrome.storage.session`. `vi.mock` is hoisted above the imports, so both stores see the mock. */
const sessionData = vi.hoisted(() => new Map<string, unknown>());

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        get: (key: string) =>
          Promise.resolve(sessionData.has(key) ? { [key]: structuredClone(sessionData.get(key)) } : {}),
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

const LINKED: ConnectionRegistry = {
  ...EMPTY_CONNECTION_REGISTRY,
  claude: {
    revision: 1,
    link: {
      provider: 'claude',
      tabId: 4,
      conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      canonicalUrl: 'https://claude.ai/chat/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      state: { kind: 'linked' },
    },
  },
};

describe('session connection store', () => {
  beforeEach(() => {
    sessionData.clear();
  });

  it('round-trips the registry', async () => {
    const store = createSessionConnectionStore();
    expect(await store.load()).toBeNull();
    await store.save(LINKED);
    expect(await store.load()).toEqual(LINKED);
  });

  it('discards a corrupted record instead of trusting it', async () => {
    sessionData.set(CONNECTIONS_KEY, { chatgpt: { revision: 'x' } });
    expect(await createSessionConnectionStore().load()).toBeNull();
  });
});

describe('isolation between the simulated debate and conversation links', () => {
  beforeEach(() => {
    sessionData.clear();
  });

  it('stores links under their own key, never inside the debate checkpoint', async () => {
    expect(CONNECTIONS_KEY).not.toBe(CHECKPOINT_KEY);
    await createSessionConnectionStore().save(LINKED);
    expect([...sessionData.keys()]).toEqual([CONNECTIONS_KEY]);
  });

  it('stores only minimal link metadata', async () => {
    await createSessionConnectionStore().save(LINKED);
    const stored = sessionData.get(CONNECTIONS_KEY) as ConnectionRegistry;
    expect(Object.keys(stored.claude.link ?? {}).sort()).toEqual([
      'canonicalUrl',
      'conversationId',
      'provider',
      'state',
      'tabId',
    ]);
  });
});
