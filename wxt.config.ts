import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ThirdMind',
    description:
      'Structured multi-round debate between a human and AI participants. Debates are simulated; ChatGPT and Claude tabs can be linked.',
    // `sidePanel` is also added automatically by WXT for the side panel entrypoint.
    // `storage` is used for the in-memory operational checkpoint and conversation links (storage.session).
    // `tabs` exposes the URL and title of open tabs, which is needed to discover existing ChatGPT and Claude
    // conversations. It is sensitive: see docs/architecture/conversation-links.md. No host permissions are requested.
    permissions: ['sidePanel', 'storage', 'tabs'],
    action: {
      default_title: 'Open ThirdMind',
    },
  },
});
