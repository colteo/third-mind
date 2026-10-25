import { describe, expect, it, vi } from 'vitest';
import type { ConnectionCoordinator, ConnectionsSnapshot } from '../application';
import { handlePageCheck } from './background-host';
import type { ProviderTransport } from './provider-transport';

vi.mock('wxt/browser', () => ({ browser: {} }));

function fixture() {
  let revision = 1;
  const snapshot = (): ConnectionsSnapshot => ({
    discovery: { status: 'ready', tabs: [], unavailableTabCount: 0 },
    registry: {
      chatgpt: { revision, link: { provider: 'chatgpt', origin: 'https://chatgpt.com', tabId: 5, identity: { kind: 'pending' }, state: { kind: 'linked' } } },
      claude: { revision: 0, link: null },
    },
  });
  const refresh = vi.fn(async () => undefined);
  const connections = { refresh, getSnapshot: snapshot } as unknown as ConnectionCoordinator;
  const probe = vi.fn(async () => ({ ok: false as const, failure: { kind: 'content-script-unavailable' as const, outcome: 'not-performed' as const } }));
  const transport = { probe } as unknown as ProviderTransport;
  const postMessage = vi.fn();
  const port = { postMessage } as unknown as Parameters<typeof handlePageCheck>[3];
  const run = () => handlePageCheck(connections, transport, new Set([port]), port, { type: 'check-provider-page', provider: 'chatgpt' });
  return { run, refresh, probe, postMessage, changeLink: () => { revision += 1; } };
}

describe('developer browser diagnostics host', () => {
  it('checks the approved empty-chat tab and returns metadata without persisting', async () => {
    const f = fixture();
    await f.run();
    expect(f.probe).toHaveBeenCalledWith(5, 'chatgpt');
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'page-check', check: expect.objectContaining({ provider: 'chatgpt', tabId: 5, linkRevision: 1, checkedAt: expect.any(String) }),
    }));
  });

  it('discards the probe when approval changes while it is running', async () => {
    const f = fixture();
    f.probe.mockImplementationOnce(async () => {
      f.changeLink();
      return { ok: false, failure: { kind: 'content-script-unavailable', outcome: 'not-performed' } };
    });
    await f.run();
    expect(f.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'page-check' }));
    expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'command-rejected' }));
  });

  it('rejects diagnostic commands in production before probing', async () => {
    vi.stubEnv('DEV', false);
    try {
      const f = fixture();
      await f.run();
      expect(f.probe).not.toHaveBeenCalled();
      expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'command-rejected' }));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
