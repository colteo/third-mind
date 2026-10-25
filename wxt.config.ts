import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ThirdMind',
    description:
      'Structured debate with local simulation and links to existing or empty ChatGPT and Claude browser conversations.',
    // `sidePanel` is also added automatically by WXT for the side panel entrypoint.
    // `storage` is used for the in-memory operational checkpoint and conversation links (storage.session).
    // `tabs` exposes the URL and title of open tabs, which is needed to discover existing ChatGPT and Claude
    // conversations. It is sensitive: see docs/architecture/conversation-links.md.
    //
    // Page access is limited to
    // the two content scripts in src/entrypoints/*.content.ts, which WXT adds to `content_scripts` with exactly
    // `https://chatgpt.com/*` and `https://claude.ai/*`, top frame only. Chrome shows them as "Read and change your
    // data on chatgpt.com and claude.ai". (`wxt dev` additionally adds those patterns as host permissions for
    // reloading; production builds do not.) See docs/adr/0004-provider-content-script-boundary.md.
    permissions: ['sidePanel', 'storage', 'tabs'],
    action: {
      default_title: 'Open ThirdMind',
    },
  },
});
