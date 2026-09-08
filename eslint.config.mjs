import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['.claude/**', 'macos/.build/**', 'macos/build/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, chrome: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
];
