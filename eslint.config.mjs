import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.bun/**',
      'coverage/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Concorrência: prevenção estrita de Promises não tratadas (transações, locks e filas)
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Blindagem de tipagem: proibição de any e variáveis soltas
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // Boas práticas e higiene: incentivo a logger estruturado (Pino)
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // NestJS: injeção de dependência via metadata exige imports de valor em tempo de execução
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Scripts utilitários de CLI (migrations e checagens) utilizam stdout/stderr diretamente
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
