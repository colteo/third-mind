# Contributing to ThirdMind

Thank you for your interest in ThirdMind. The project is in an early phase, so please open an issue to discuss significant changes before starting work on them.

## Ground rules

- **Language.** Code, comments, identifiers, documentation, error messages and user-facing strings are written in English.
- **Honesty about simulation.** Never present simulated output as real provider output, and never document a feature as complete before it is.
- **No live provider integration without discussion.** Changes that touch ChatGPT or Claude websites (content scripts, host permissions, DOM access, automated messaging) need an agreed design first.

## Setup

```powershell
cd C:\third-mind
npm install
npm run verify
```

`npm run verify` runs the TypeScript check, ESLint, the unit tests and a production build. CI runs the same steps.

## Architecture rules

Read the [architecture overview](docs/architecture/overview.md) first. In short:

- `src/domain` is pure. It has no Chrome APIs, DOM, React, storage, `Date.now()` or random ids. State must remain JSON-serializable.
- New behaviour in the debate engine is expressed as events (`evolve`) and commands (`decide`). Every new event needs documented preconditions and effects in [debate-engine.md](docs/architecture/debate-engine.md), and tests for valid, duplicate and invalid cases.
- External capabilities go behind a port in `src/ports` and are wired in the composition root (`src/extension/background-host.ts`).
- Module boundaries are enforced by ESLint. Do not silence `no-restricted-imports`; restructure the code instead.
- Prefer small, explicit code over abstractions. Do not add dependency-injection frameworks, global state libraries, component libraries or schema libraries without a concrete need agreed in an issue.

## Architecture decisions

Significant decisions are recorded as ADRs in [`docs/adr/`](docs/adr/). Add a new numbered ADR when you change a module boundary, introduce a dependency with architectural impact, or change persistence or messaging semantics.

## Tests

- Domain and application changes need Vitest tests that assert observable behaviour and invariants, not implementation details.
- Use `src/test-support/fixtures.ts` to build sessions and drive the engine.
- Do not quote coverage numbers that you have not generated with `npm run test:coverage`.

## Commits and pull requests

- Keep pull requests focused on one change.
- Describe what changed, why, and how you verified it (commands run, manual Chrome checks).
- Make sure `npm run verify` passes locally.
