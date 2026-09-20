import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// The type-checked strict tier, because a library's bugs are the ones the checker can see:
// an unhandled promise, a switch with an arm missing, a deprecated call, an `any` flowing out.
// Four rules are configured rather than obeyed, each with its reason beside it.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/generated/**', 'tests/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', 'tools/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // A message names an amount, a count or a status, and those are numbers and bigints.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `noUncheckedIndexedAccess` makes every element read `T | undefined`. A byte codec reads
      // an element after it checked the length, and the assertion is that check's name.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // An arrow that answers a void call, `() => work()`, says that the value is dropped on purpose.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    // A fake answers a promise without awaiting anything, and a test reads what a build emits.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  }
)
