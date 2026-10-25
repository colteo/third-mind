import type { ConversationProviderId } from '../../domain';
import type { LiveAdapterRegistry, LiveFailure, LiveProviderAdapter } from '../../ports';

const SITES: Readonly<Record<ConversationProviderId, { readonly label: string; readonly host: string }>> = {
  chatgpt: { label: 'ChatGPT', host: 'chatgpt.com' },
  claude: { label: 'Claude', host: 'claude.ai' },
};

/**
 * Live adapter for the consumer chat website of a provider (`chatgpt.com`,
 * `claude.ai`) as ThirdMind ships it.
 *
 * ThirdMind can reach these pages technically: a content script answers
 * readiness probes. That does not make automated typing, submitting or
 * reading of replies a supported or permitted way to use the sites, and
 * neither provider documents such a route for third-party extensions. This
 * adapter therefore declares the route `not-authorized`, reports submission
 * and response acquisition as unavailable, and refuses every operation
 * without touching the page. It exists so the live preflight can explain
 * precisely why a live debate cannot start.
 *
 * An authorized integration (see docs/architecture/live-execution.md) replaces
 * this adapter in the composition root; nothing else changes.
 */
export function createConsumerSiteAdapter(provider: ConversationProviderId): LiveProviderAdapter {
  const { label, host } = SITES[provider];
  const reason = `ThirdMind has no authorized route for automated messaging on ${host}. Reaching the ${label} page is not permission to automate it, so ThirdMind does not type into, submit to or read replies from the ${label} website.`;
  const refusal: LiveFailure = { kind: 'not-authorized', outcome: 'not-performed', message: reason };
  return {
    provider,
    route: { id: `${provider}-consumer-site`, label: `${label} website (${host})` },
    authorization: { kind: 'not-authorized', reason },
    capabilities: () =>
      Promise.resolve({
        submission: {
          status: 'unavailable',
          reason: `Submitting debate messages to ${label} is not implemented: no authorized submission route exists for the ${label} website.`,
        },
        responseAcquisition: {
          status: 'unavailable',
          reason: `Reading ${label} responses is not implemented: ThirdMind does not extract chatbot output from the ${label} website.`,
        },
      }),
    submit: () => Promise.resolve({ ok: false, failure: refusal }),
    awaitResponse: () => Promise.resolve({ ok: false, failure: refusal }),
  };
}

/** The adapters installed in the shipped extension. Neither supports live debates. */
export function createConsumerSiteAdapters(): LiveAdapterRegistry {
  return { chatgpt: createConsumerSiteAdapter('chatgpt'), claude: createConsumerSiteAdapter('claude') };
}
