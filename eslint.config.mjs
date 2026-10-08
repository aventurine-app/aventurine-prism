// ─── ESLint flat config ──────────────────────────────────────────────────────
// Dev-only static analysis; nothing here affects what ships (the app has no
// build step). Run with `npm run lint` from electron/. ESLint lives in
// electron/node_modules; this file sits at the repo root so one config covers
// both worlds:
//
//   static/js/**   Classic browser <script>s sharing one global scope. Every
//                  cross-file name is listed in `appGlobals` below, so the list
//                  documents the real cross-file API and anything unlisted
//                  stays an error.
//   electron/**    CommonJS under Node (main process, backend, scripts, tests).

import { createRequire } from 'node:module';
const require = createRequire(new URL('./electron/', import.meta.url));
const js = require('@eslint/js');
const globals = require('globals');

// Each is defined in exactly one file, attached with `window.X = X`.
const appGlobals = {
    // core/
    escapeHtml: 'readonly',     // escape.js
    Fmt: 'readonly',            // format.js
    iconSvg: 'readonly',        // icons.js (data from the generated icon-data.js)
    api: 'readonly',            // api.js
    // sim/ (also require()d by the backend and the tests)
    CitrineCatalog: 'readonly',
    CitrinePlan: 'readonly',
    CitrineEngine: 'readonly',
    // shell/
    UI: 'readonly',             // ui.js
    Settings: 'readonly',       // settings.js
    // app/
    Describe: 'readonly',
    CitrineExample: 'readonly',
    Store: 'readonly',
    Tabs: 'readonly',
    Library: 'readonly',
    Canvas: 'readonly',
    Inspector: 'readonly',
    Chart: 'readonly',
    Outlook: 'readonly',
    Lock: 'readonly',
    // electron/preload.js bridge (absent outside Electron; feature-detect)
    electronWindow: 'readonly',
    electronApp: 'readonly',
    citrineApi: 'readonly',
};

export default [
    {
        ignores: [
            'electron/dist/**',
            '**/node_modules/**',
            '.scratch/**',
            'static/js/core/icon-data.js',
        ],
    },

    js.configs.recommended,

    {
        rules: {
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },

    {
        files: ['static/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: { ...globals.browser, ...appGlobals },
        },
    },

    // The simulation core is dual-environment: classic scripts that also
    // module.exports themselves for Node.
    {
        files: ['static/js/sim/*.js'],
        languageOptions: { globals: { module: 'readonly', require: 'readonly' } },
    },

    {
        files: ['electron/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: globals.node,
        },
    },

    {
        files: ['eslint.config.mjs'],
        languageOptions: { sourceType: 'module', globals: globals.node },
    },
];
