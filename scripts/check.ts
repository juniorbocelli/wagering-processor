import { join } from 'node:path';

interface Step {
  name: string;
  cmd: string[];
  needsDocker?: boolean;
}

const PROMETHEUS_IMAGE = 'prom/prometheus:v2.53.0';
const observability = join(process.cwd(), 'docker', 'observability');

function promtool(...args: string[]): string[] {
  return [
    'docker',
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${observability},target=/obs,readonly`,
    '--workdir',
    '/obs',
    '--entrypoint',
    'promtool',
    PROMETHEUS_IMAGE,
    ...args,
  ];
}

const steps: Step[] = [
  { name: 'Check Money (No Floats)', cmd: ['bun', 'run', 'check:money'] },
  { name: 'ESLint', cmd: ['bun', 'run', 'lint'] },
  { name: 'TypeScript Typecheck', cmd: ['bun', 'run', 'typecheck'] },
  { name: 'Unit & Property Tests', cmd: ['bun', 'test', 'test/unit'] },
  {
    name: 'Docker Compose Config',
    cmd: ['docker', 'compose', 'config', '-q'],
    needsDocker: true,
  },
  {
    name: 'Prometheus Alert Rules Check',
    cmd: promtool('check', 'rules', 'alerts.yml'),
    needsDocker: true,
  },
  {
    name: 'Prometheus Alert Rules Unit Tests',
    cmd: promtool('test', 'rules', 'alerts.test.yml'),
    needsDocker: true,
  },
  {
    name: 'Start Infrastructure (Postgres & LocalStack)',
    cmd: ['docker', 'compose', 'up', '-d', '--wait', 'postgres', 'localstack'],
    needsDocker: true,
  },
  {
    name: 'Run Migrations',
    cmd: ['bun', 'run', 'migration:up'],
    needsDocker: true,
  },
  {
    name: 'Integration Tests',
    cmd: ['bun', 'test', 'test/integration'],
    needsDocker: true,
  },
  {
    name: 'Concurrency Cluster Tests',
    cmd: ['bun', 'test', 'test/concurrency'],
    needsDocker: true,
  },
  {
    name: 'Build Production Docker Image',
    cmd: ['docker', 'build', '-t', 'wagering-processor:check', '.'],
    needsDocker: true,
  },
];

const quick = process.argv.includes('--quick');
const selected = steps.filter((step) => !quick || !step.needsDocker);
const results: { name: string; ok: boolean; seconds: number }[] = [];

console.log(`\n\x1b[1mIniciando Verificação Completa da Aplicação (${quick ? 'Modo Rápido' : 'Modo Completo'})\x1b[0m`);

for (const step of selected) {
  console.log(`\n\x1b[1m▶ ${step.name}\x1b[0m`);
  const startedAt = performance.now();
  const proc = Bun.spawn(step.cmd, { stdout: 'inherit', stderr: 'inherit' });
  const ok = (await proc.exited) === 0;
  results.push({ name: step.name, ok, seconds: (performance.now() - startedAt) / 1000 });
  if (!ok) {
    break;
  }
}

console.log('\n\x1b[1m================ Resumo da Verificação ================\x1b[0m');
for (const result of results) {
  const mark = result.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`${mark} ${result.name.padEnd(46)} ${result.seconds.toFixed(1)}s`);
}
for (const step of selected.slice(results.length)) {
  console.log(`- ${step.name.padEnd(46)} não executado`);
}
if (quick) {
  console.log('\nModo --quick: etapas dependentes de contêineres Docker foram ignoradas.');
}

process.exit(results.every((result) => result.ok) ? 0 : 1);
