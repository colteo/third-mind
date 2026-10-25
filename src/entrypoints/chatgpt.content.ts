import { defineContentScript } from 'wxt/utils/define-content-script';
import { startProviderContentScript } from '../extension/provider-content-script';

// Exact origin only; top frame only (`allFrames` defaults to false); isolated world.
// See docs/adr/0004-provider-content-script-boundary.md.
export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    startProviderContentScript('chatgpt', ctx);
  },
});
