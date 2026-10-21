/**
 * Guarda-corpos do ADR-001: falha se construções de ponto flutuante ou o tipo `number`
 * aparecerem no domínio, na aplicação e em mappers/DTOs monetários.
 *
 * Usos legítimos de `number` não monetário (ex.: `version`, contadores) são liberados
 * linha a linha com o comentário `check-money:allow` na mesma linha.
 *
 * Uso: bun scripts/check-money.ts
 */
import { Glob } from 'bun';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const FORBIDDEN = /parseFloat|Number\(|toFixed\(|Math\.(round|floor|ceil|trunc)|:\s*number\b/;
const ALLOW_MARKER = 'check-money:allow';

const GLOBS = [
  'src/domain/**/*.ts',
  'src/application/**/*.ts',
  'src/infrastructure/persistence/**/mappers/**/*.ts',
  'src/interfaces/http/dto/**/*.ts',
];

// fileURLToPath decodifica percent-encoding (espaços, acentos) ao contrário de `URL.pathname`.
const root = fileURLToPath(new URL('..', import.meta.url));
const violations: string[] = [];

for (const pattern of GLOBS) {
  for await (const file of new Glob(pattern).scan({ cwd: root })) {
    const lines = (await Bun.file(join(root, file)).text()).split('\n');
    lines.forEach((line, index) => {
      if (FORBIDDEN.test(line) && !line.includes(ALLOW_MARKER)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error('check-money: forbidden floating-point constructs found:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log('check-money: OK');
