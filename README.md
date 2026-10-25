# ThirdMind

ThirdMind is a free, open-source Chrome extension for **collaborative reasoning between a human, ChatGPT and Claude**. It does not simply show two chatbot answers side by side. It runs a **structured, multi-round debate**: the human sets the question and constraints, and the debate engine coordinates independent analysis, cross-examination, refinement and convergence.

> **Status: Phase 2.2B foundation (provider page transport).** Debates still run in **simulation mode only**: every participant response is produced by a deterministic local simulator and is labelled as simulated. In addition, the side panel can **link** one ChatGPT tab and one Claude tab, each showing either an existing conversation or a new, empty chat. A linked new chat is recorded as *pending* until the provider gives it a conversation address. Small content scripts on `chatgpt.com` and `claude.ai` let the background service **check whether a linked page is ready** (page kind, loading state, visibility, presence of the message box). ThirdMind does **not** read conversation contents, send messages or automate either website, and the simulated debate does not use linked conversations. **Live AI message exchange is not implemented and has not been tested against the real websites.**

## What is implemented

- A Manifest V3 Chrome extension built with WXT, React and TypeScript (strict mode).
- A Chrome **side panel** UI with:
  - session setup: topic, optional constraints, simulation scenario;
  - a participant overview (Human, GPT Simulator, Claude Simulator);
  - phase progress and a debate timeline grouped by round;
  - controls (start, pause, resume, add constraint, reset) that reflect the actual engine state;
  - results as a **structured report** and a **conversational summary**, with disagreements and unresolved questions stated explicitly.
- A **pure, deterministic debate engine** (`evolve` and `decide`) with four logical rounds:
  1. Independent Analysis (both participants requested concurrently, neither sees the other)
  2. Cross-Examination
  3. Refinement
  4. Convergence
- **Adaptive stopping.** The engine may finish early only when every participant's structured assessment reports no material issues. This is never considered after round 1, and the maximum of four rounds is always enforced.
- **Human interruption.** Pause waits for in-flight work, constraints can be added while paused, and those constraints are included in every later request.
- **Side-effect safety.** Each provider request has a stable operation id, the dispatch is recorded before the provider is called (write-ahead), and in-flight work is never replayed automatically after a restart.
- **MV3 recovery.** An operational checkpoint in `chrome.storage.session` lets the debate survive service worker restarts.
- **Linked conversations (Phase 2.1).** A separate *Linked conversations* section in the side panel:
  - discovers open ChatGPT and Claude tabs with the Chrome Tabs API and classifies them by exact origin and URL pattern;
  - lists open conversations per provider and lets the human select and explicitly confirm one per provider (never automatically);
  - shows each link as *Linked*, *Unavailable* (temporary), *Stale* (the tab now shows something else) or *Disconnected* (the tab was closed);
  - supports **Disconnect**, explicit **Reconnect** to a tab that shows the same conversation, and **Refresh**;
  - keeps links current through tab events and re-verifies them on service worker start and on every panel connection.
- **New chats with a pending identity (Phase 2.2A).** In the same section:
  - open new-chat pages (`https://chatgpt.com/`, `https://claude.ai/new`, `https://claude.ai/`) are listed under *New chats*, separately from saved conversations, and can be linked explicitly;
  - a linked new chat shows *New chat — pending first message*; no conversation id or URL is invented for it;
  - when the same tab moves directly from the new chat to a saved conversation while ThirdMind is watching, the conversation is recorded on the existing link (no second connection);
  - when that cannot be established from browser metadata (for example, after a service worker restart, or when the conversation is open in another tab as well), the panel shows *Confirmation required* and explains why, and nothing is recorded until the human clicks **Confirm this conversation**;
  - a conversation that was already open elsewhere before the transition is never adopted; the link becomes *Stale*.

  See [docs/architecture/conversation-links.md](docs/architecture/conversation-links.md) and [ADR 0003](docs/adr/0003-pending-conversation-identity.md).
- **Provider page transport (Phase 2.2B foundation).** The groundwork for real ChatGPT and Claude integration:
  - content scripts for exactly `https://chatgpt.com/*` and `https://claude.ai/*`, top frame only, isolated world;
  - typed, validated messages between the service worker and those scripts, with sender checks in both directions and no message that carries code or text;
  - a provider-neutral `ProviderPageTransport` port that reports which provider owns a tab, whether it shows a conversation, a new chat or another page, whether it has loaded and is visible, and whether the message box exists;
  - explicit handling of missing content scripts, closed tabs, navigation and reloads during a request, service worker restarts and timeouts. A timeout is reported as an *unknown* outcome, never as a failure on the page;
  - a **Check page connection** button on a linked conversation. The check is diagnostic: it does not change the link or the debate.

  See [docs/architecture/provider-transport.md](docs/architecture/provider-transport.md) and [ADR 0004](docs/adr/0004-provider-content-script-boundary.md).
- Vitest unit tests for the domain, application, simulator, messaging protocols and provider transport.
- GitHub Actions CI (typecheck, lint, test with coverage, build).

## What is simulated

- **GPT Simulator** and **Claude Simulator** are scripted stand-ins with different viewpoints: one incremental and evidence-first, one risk-focused. They are *not* GPT or Claude. Their output is generic test data that references the topic and constraints.
- The structured assessments that drive early stopping are scripted. No semantic judgement or reasoning-quality score is involved.
- Three scenarios are available: **Full debate**, **Early convergence** and **Provider failure**.

## Supported conversation URLs

| Provider | Saved conversation URLs                                                   | New-chat URLs                                  |
| -------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| ChatGPT  | `https://chatgpt.com/c/<uuid>`, `https://chatgpt.com/g/g-<slug>/c/<uuid>` | `https://chatgpt.com/`                         |
| Claude   | `https://claude.ai/chat/<uuid>`                                           | `https://claude.ai/new`, `https://claude.ai/`  |

Query strings and fragments are ignored, except that temporary chats (`?temporary-chat=…`) and Claude incognito chats (`?incognito`) are not offered as new chats, because they are never saved. Other pages on these sites (projects, shared links, settings, new chats inside custom GPTs or projects, any unknown path) are shown as "neither a saved conversation nor a new chat" and cannot be linked. Lookalike hosts, other schemes or ports, `chat.openai.com` and `www.` variants are not recognized. Claude's site root is accepted as a new-chat page because it shows one for signed-in users; that is a manual observation, not a guarantee.

## Permissions

| Permission  | Why                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `sidePanel` | The side panel UI                                                                                                            |
| `storage`   | `chrome.storage.session`: the debate checkpoint and the conversation links (in memory, cleared on browser exit or extension reload) |
| `tabs`      | Reading the URL and title of open tabs to discover existing ChatGPT and Claude conversations                                 |

The `tabs` permission is sensitive. Chrome shows it as *"Read your browsing history"* because it exposes the URL and title of every open tab. ThirdMind classifies each tab in memory and immediately discards everything that is not a ChatGPT or Claude tab. For linked conversations it stores only the provider, expected provider origin, tab id, conversation identity (pending, or conversation id and canonical conversation URL) and connection state, never titles or content, and it never sends or logs this metadata. The full justification is in [docs/architecture/conversation-links.md](docs/architecture/conversation-links.md#permission-tabs).

**Content scripts (Phase 2.2B foundation).** The manifest declares two content scripts:

| Script          | Matches                  | Frames    | World    | Reads                                                                    |
| --------------- | ------------------------ | --------- | -------- | ------------------------------------------------------------------------ |
| `chatgpt.js`    | `https://chatgpt.com/*`  | top only  | isolated | its own URL, `readyState`, `visibilityState`, whether `#prompt-textarea` exists |
| `claude.js`     | `https://claude.ai/*`    | top only  | isolated | its own URL, `readyState`, `visibilityState`, whether the message box element exists |

No `permissions` entry was added, and there are **no** `host_permissions`, `scripting`, `webNavigation`, `webRequest` or `cookies`. Because content scripts run on those two sites, Chrome shows an additional warning such as *"Read and change your data on chatgpt.com and claude.ai"*, and an already installed copy is disabled until the new warning is accepted. The scripts never read conversation text, titles or other page content, never type, click or submit, and never make network requests. The security boundary is described in [ADR 0004](docs/adr/0004-provider-content-script-boundary.md).

## What is not implemented yet

- Any message exchange with ChatGPT or Claude: no conversation reading, no prompt submission, no automation. The content scripts only report page readiness. Linked conversations and new chats are associations only. Reading replies and submitting prompts are the next steps (see [provider-transport.md](docs/architecture/provider-transport.md#next-steps-toward-message-exchange)).
- Verification of the provider transport against the real websites by automated tests. The message box selectors are based on manual inspection and are unverified.
- Injecting the content scripts into provider tabs that were open before ThirdMind was installed, updated or reloaded. Those tabs must be reloaded.
- Telling the first message of a new chat apart from sidebar navigation. Tab URLs cannot distinguish them; see [ADR 0003](docs/adr/0003-pending-conversation-identity.md#consequences).
- Using linked conversations in a debate. The debate still uses the simulators.
- Persistent history of past debates. The checkpoint is in memory only and is discarded when the browser exits.
- Links that survive an extension reload or a browser restart (`storage.session` is cleared in both cases).
- End-to-end browser tests (deferred to Phase 2, see [docs/architecture/testing.md](docs/architecture/testing.md)).
- Extension icons, localization and a published Chrome Web Store listing.
- A license. One has not been selected yet.

## Prerequisites

- **Node.js 22.12 or later** (Node 24 is recommended; see `.nvmrc`). Check with `node --version`.
- **npm** (ships with Node.js).
- **Google Chrome** or another Chromium browser with side panel support (Chrome 116 or later).

## Installation

```powershell
cd C:\third-mind
npm install
```

`npm install` also runs `wxt prepare` (the `postinstall` script), which generates `.wxt/` including the TypeScript configuration that `tsconfig.json` extends. It also creates `package-lock.json`, which should be committed.

## Development

```powershell
npm run dev        # Start WXT in development mode with hot reload
```

WXT writes the development build to `.output/chrome-mv3-dev/`. If WXT cannot launch a browser automatically (that requires the optional `web-ext` package), load that directory manually as described below.

## Build

```powershell
npm run build      # Production build in .output/chrome-mv3/
npm run zip        # Zipped build in .output/
```

## Loading the unpacked extension in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select `C:\third-mind\.output\chrome-mv3`.
5. Click the ThirdMind toolbar icon (pin it from the puzzle-piece menu if needed). The side panel opens.

Manual smoke test:

1. Enter a topic, choose **Full debate** and the **Slow** response pace, and click **Start debate**. Both simulators start round 1 concurrently. (The **Standard** pace finishes a whole debate in about six seconds, which leaves little time to press Pause.)
2. Click **Pause** during round 1, 2 or 3. The status shows *Pausing…* until the in-flight simulated responses arrive, then *Paused*. No further round starts.
3. Add a constraint and click **Resume**. Every later contribution, from both simulators, lists the constraint under "Constraints respected". If you pause during the final round, constraints cannot be added (no request would carry them) and the panel says so.
4. When the debate completes, the **Results** card appears above the timeline. Switch between **Structured report** and **Conversational summary**.
5. Click **Start a new debate**, confirm, and start a second debate with a different topic.
6. Try **Early convergence** (stops after round 3) and **Provider failure** (the Claude simulator fails in round 2).

To exercise recovery, start a debate, then stop the service worker from `chrome://extensions` → ThirdMind → *service worker* → DevTools, or from `chrome://serviceworker-internals`. Reopen the panel. The session is restored as *Paused*, and interrupted requests are listed with a **Request again** button.

### Smoke test: linked conversations (Phase 2.1)

After rebuilding, reload the extension in `chrome://extensions`. If the extension was installed before, Chrome disables it until you accept the new `tabs` permission (*Read your browsing history*); accept it, or remove the extension and load it unpacked again.

1. **Empty state.** With no ChatGPT or Claude tab open, open the panel. *Linked conversations* says "No ChatGPT conversations or new chats found. Open a ChatGPT conversation or a new chat in another tab and click Refresh." and the same for Claude.
2. **Provider page only.** Open a ChatGPT page that is neither a conversation nor a new chat (for example `https://chatgpt.com/gpts`) and click **Refresh**. The ChatGPT section says that one ChatGPT tab is open but shows neither a saved conversation nor a new chat. Nothing can be linked.
3. **Discovery.** Open two existing ChatGPT conversations (`https://chatgpt.com/c/…`) and one Claude conversation (`https://claude.ai/chat/…`) in separate tabs and click **Refresh**. ChatGPT lists two candidates and Claude one, each with its tab title, a shortened conversation id and *Available*. Nothing is selected, and **Link selected conversation** stays disabled, also for Claude's single candidate.
4. **Link.** Select a ChatGPT conversation and click **Link selected conversation**. It shows *Linked* with the tab title. Link the Claude conversation the same way.
5. **Simulation unaffected.** Start a simulated debate. It runs exactly as before and is still labelled as simulated. The links are unchanged and unused.
6. **Navigation.** In the linked ChatGPT tab, open a different conversation from the sidebar. Without any action in ThirdMind, the ChatGPT link becomes *Stale*: "The tab now shows a different conversation." Click **New chat** in the linked Claude tab: the Claude link becomes *Stale* ("no longer shows this conversation").
7. **Reconnect.** Navigate the ChatGPT tab back to the originally linked conversation. The link stays *Stale* (there is no automatic relink), and the tab is offered with a **Reconnect** button. Click it: the link becomes *Linked*.
8. **Tab closure.** Close the linked ChatGPT tab. The link becomes *Disconnected*: "The tab was closed." Reopen the same conversation in a new tab and click **Refresh**: **Reconnect** is offered for the new tab.
9. **Disconnect.** Click **Disconnect**. The section returns to the selection list.
10. **Panel and worker restart.** Link a conversation, close the panel, navigate the linked tab to another conversation, then stop the service worker (`chrome://serviceworker-internals` → ThirdMind → *Stop*). Reopen the panel: the link is restored and shown as *Stale*, because it was reconciled with the open tabs.
11. **Extension reload.** Reload the extension in `chrome://extensions` and reopen the panel: no links remain. This is expected, because `storage.session` is cleared.
12. **Lookalike URLs.** Open a non-provider page whose URL mentions a conversation URL only in its query (for example `https://example.com/?u=https://chatgpt.com/c/…`) and click **Refresh**. It is not listed.
13. **Narrow panel.** Drag the side panel to its narrowest width. Titles wrap, and every button stays reachable.

### Smoke test: new chats (Phase 2.2A)

These steps need signed-in ChatGPT and Claude accounts. They are manual; the automated tests do not use provider accounts.

1. **Discovery.** Open `https://chatgpt.com/` and `https://claude.ai/new` in separate tabs and click **Refresh**. Each provider lists the tab under *New chats*, marked *New chat*, separately from *Saved conversations*. Nothing is selected.
2. **Unsaved chats are not offered.** Open `https://chatgpt.com/?temporary-chat=true` and click **Refresh**. It is not listed as a new chat.
3. **Link a new chat.** Select the ChatGPT new chat and click **Link selected new chat**. The badge reads *New chat — pending first message*, and the text says that linking does not send any message.
4. **Identity reconciliation.** Type and send a first message yourself in that ChatGPT tab. When the address changes to `https://chatgpt.com/c/…`, the panel shows *Linked*, the shortened conversation id and "recorded from the linked new chat". There is still exactly one ChatGPT link. Repeat with Claude.
5. **Confirmation after a restart.** Link a new Claude chat, then stop the service worker (`chrome://serviceworker-internals` → ThirdMind → *Stop*). Send the first message in the Claude tab, then reopen the panel. The link shows *Confirmation required* with the observed conversation and an explanation. Click **Confirm this conversation**: it becomes *Linked*, "confirmed by you".
6. **Unrelated conversation.** Link a new ChatGPT chat while another tab already shows an existing ChatGPT conversation. In the linked tab, open that same existing conversation from the sidebar. The link becomes *Stale* ("opened a conversation that is not the linked new chat"); nothing is recorded.
7. **Leaving the new chat.** Link a new chat, then open the provider's settings page or another website in that tab. The link becomes *Stale* ("left the new chat before a conversation was saved").
8. **Closing.** Link a new chat and close its tab. The link becomes *Disconnected*. Open a new chat again: it is listed as an ordinary new chat, with no **Reconnect** button.
9. **Known limitation.** Link a new chat and open an existing conversation from the sidebar that is **not** open in another tab. ThirdMind records it as the new chat's conversation, because the URL change looks the same as a first message. Use **Disconnect** if that happens.

### Smoke test: page connection (Phase 2.2B foundation)

These steps verify the transport in real Chrome. They need signed-in ChatGPT and Claude accounts. Nothing in them sends a message.

1. **Manifest.** Run `npm run build`, open `.output/chrome-mv3/manifest.json` and check that `content_scripts` lists exactly `https://chatgpt.com/*` and `https://claude.ai/*`, that there is no `host_permissions` key, and that `permissions` is `sidePanel`, `storage`, `tabs`.
2. **Permission prompt.** Reload the extension in `chrome://extensions`. Chrome asks to accept access to the two sites (or disables the extension until you do). Accept it.
3. **Missing content script.** Without reloading an already open ChatGPT conversation tab, link it and click **Check page connection**. The panel says the page connection is not active and asks you to reload the tab.
4. **Ready page.** Reload that tab, wait until it has loaded, and click **Check page connection** again. The panel reports *Page connection active*, a saved conversation, *visible* or *in the background*, and that the message box was found. Repeat with a linked Claude conversation and with a linked new chat on each site.
5. **Hidden tab.** Switch to another tab in the same window and check again from the panel. The page is reported as *in the background*.
6. **Not signed in.** In a separate profile or after signing out, open `https://claude.ai/new`, link it and check it. Expect *no message box was found* (or a provider page, depending on where the site redirects). Record what you observe.
7. **Navigation.** Check a linked conversation, then open a different conversation in that tab. The link becomes *Stale*, **Check page connection** disappears, and the earlier result is no longer shown. (A navigation *during* a check takes milliseconds to hit by hand; it is covered by the unit tests.)
8. **Closed tab.** Close a linked tab. The link becomes *Disconnected* and **Check page connection** is no longer offered.
9. **Worker restart.** Stop the service worker (`chrome://serviceworker-internals` → ThirdMind → *Stop*), reopen the panel and check a linked tab again. It succeeds without reloading the provider tab.
10. **Console.** In the provider tab's DevTools, under the content script context *ThirdMind*, there are no errors. In the service worker console there are no errors that contain URLs or titles.
11. **Selectors.** If step 4 reports *no message box was found* on a signed-in, loaded chat page, the provider changed its page. Note the provider and update `src/infrastructure/provider-pages.ts`.

## Tests

```powershell
npm test               # Run all unit tests once
npm run test:watch     # Watch mode
npm run test:coverage  # Tests with a V8 coverage report in coverage/
npm run typecheck      # TypeScript strict type check
npm run lint           # ESLint, including module-boundary rules
npm run verify         # typecheck + lint + test + build
```

## Architecture

ThirdMind is a modular monolith with lightweight hexagonal boundaries and a pure functional core ([ADR 0001](docs/adr/0001-modular-monolith-functional-core.md)).

```text
src/
├── domain/          Pure debate state machine; pure conversation link model
├── ports/           Interfaces: providers, checkpoints, clock, ids, tabs, URL recognition, connection store, page transport
├── application/     Debate runner and connection coordinator (imperative shells), read models
├── infrastructure/  Deterministic simulators, provider URL rules, provider page readiness rules, in-memory stores
├── extension/       Chrome integration: background host, messaging, storage and Tabs API adapters, provider transport and content script
├── ui/              React side panel
└── entrypoints/     WXT entrypoints (background, sidepanel, ChatGPT and Claude content scripts)
```

The debate runs in the background service worker. The side panel renders snapshots it receives over a typed `runtime.Port`. All dependencies point toward the domain, and ESLint enforces this.

More detail:

- [Architecture overview](docs/architecture/overview.md)
- [Debate engine: states, events, commands](docs/architecture/debate-engine.md)
- [Runtime, messaging and recovery](docs/architecture/runtime-and-recovery.md)
- [Conversation links (Phase 2.1 and 2.2A)](docs/architecture/conversation-links.md)
- [ADR 0003: pending conversation identity](docs/adr/0003-pending-conversation-identity.md)
- [Provider page transport (Phase 2.2B foundation)](docs/architecture/provider-transport.md)
- [ADR 0004: provider content scripts and the page transport security boundary](docs/adr/0004-provider-content-script-boundary.md)
- [Testing](docs/architecture/testing.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
