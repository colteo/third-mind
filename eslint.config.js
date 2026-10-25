import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Module boundaries (see docs/architecture/overview.md). `layer` forbids a
 * layer from importing the listed sibling directories (via relative paths)
 * and, optionally, UI or extension frameworks.
 */
const FRAMEWORKS = ['react', 'react-dom', 'react-dom/*', 'wxt', 'wxt/*', '@wxt-dev/*'];
const layer = (name, forbiddenDirs, forbiddenPackages = FRAMEWORKS) => ({
  files: [`src/${name}/**/*.{ts,tsx}`],
  ignores: ['src/**/*.test.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: `^\\.{1,2}/(.*/)?(${forbiddenDirs.join('|')})(/|$)`,
            message: `The "${name}" layer must not depend on this module. See docs/architecture/overview.md.`,
          },
          ...(forbiddenPackages.length > 0
            ? [
                {
                  group: forbiddenPackages,
                  message: `The "${name}" layer must stay framework-independent. See docs/architecture/overview.md.`,
                },
              ]
            : []),
        ],
      },
    ],
  },
});

export default defineConfig(
  globalIgnores(['.output/', '.wxt/', 'coverage/', 'node_modules/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/entrypoints/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  layer('domain', ['application', 'ports', 'infrastructure', 'extension', 'ui', 'entrypoints']),
  layer('ports', ['application', 'infrastructure', 'extension', 'ui', 'entrypoints']),
  layer('application', ['infrastructure', 'extension', 'ui', 'entrypoints']),
  layer('infrastructure', ['application', 'extension', 'ui', 'entrypoints']),
  layer('extension', ['ui', 'entrypoints'], ['react', 'react-dom', 'react-dom/*']),
  {
    // The UI talks to Chrome only through src/extension, and may read the
    // simulator's scenario catalogue (pure data) but nothing else from infrastructure.
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['wxt', 'wxt/*', '@wxt-dev/*'],
              message: 'The UI must use Chrome APIs through src/extension. See docs/architecture/overview.md.',
            },
            {
              regex: '^(?!.*infrastructure/simulator/scenarios$).*infrastructure(/|$)',
              message:
                'The UI may only import the scenario catalogue from infrastructure. See docs/architecture/overview.md.',
            },
          ],
        },
      ],
    },
  },
);
