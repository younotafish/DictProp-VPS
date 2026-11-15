import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/', '**/node_modules/', 'data/', 'server/data/', 'tmp/', 'personal_1/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Empty catch blocks are deliberate here: best-effort storage, speech and cleanup calls.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `cond ? a() : b()` and `ok && run()` as statements are side effects, not dead expressions.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // `let timer; const done = () => clearTimeout(timer); timer = setTimeout(...)` can't be a const.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // The code already breaks these in places, so they warn rather than fail; new code shouldn't add to them.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'no-control-regex': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'preserve-caught-error': 'warn',
      // TypeScript's noUnusedLocals and noUnusedParameters reject unused code in .ts files; this mainly covers the
      // scripts' .mjs files, with the same exemptions TypeScript makes.
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // The client, bundled for the browser.
    files: ['App.tsx', 'index.tsx', 'types.ts', 'components/**', 'hooks/**', 'services/**', 'views/**'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Warn only: adding a missing dependency changes when an effect runs, so each one needs a reviewed fix.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // The server, the scripts, the build configs and every test run in Node.
    files: ['server/**', 'scripts/**', 'test/**', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
);
