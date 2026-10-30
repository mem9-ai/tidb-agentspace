import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const unusedOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  ignoreRestSiblings: true,
};

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.data/**',
      'coverage/**',
      'release/**',
      'meta-service/target/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-unused-vars': ['error', unusedOptions],
      'no-constant-binary-expression': 'error',
    },
  },
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['src/**/*.{ts,tsx}'] })),
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', unusedOptions],
      '@typescript-eslint/no-explicit-any': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];
