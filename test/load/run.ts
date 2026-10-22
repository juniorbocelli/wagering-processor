/**
 * Teste de carga (`bun run test:load`) — diferencial do edital.
 *
 * Sobe 3 instâncias reais da aplicação (mesmo harness dos testes de concorrência) sobre o
 * PostgreSQL e o LocalStack do `infra:up`, gera carga HTTP em laço fechado e registra
 * throughput, p50/p95/p99, taxa de erro por status, `wallet_lock_timeouts_total` e o maior
 * `outbox_lag_seconds`. O resultado é escrito entre os marcadores de `docs/load-test.md`.
 *
 * Variáveis: LOAD_DURATION_S (15), LOAD_WARMUP_S (5), LOAD_CONCURRENCY (64),
 * LOAD_WALLETS (100), LOAD_HOT_SHARE (0.8), LOAD_INSTANCES (3).
 */
import { cpus, totalmem } from 'node:os';
import { Cluster, call } from '../support/cluster.ts';
import {
  openWalletVia,
  submit,
  wagerBody,
  type ClusterWallet,
  type WagerBody,
} from '../support/cluster-fixtures.ts';
import { connect, ensureSchema, sql } from '../support/db.ts';
import { createTestQueues } from '../support/sqs.ts';
import { sleep } from '../support/wait.ts';

const env = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
};

const DURATION_S = env('LOAD_DURATION_S', 15);
const WARMUP_S = env('LOAD_WARMUP_S', 5);
const CONCURRENCY = env('LOAD_CONCURRENCY', 64);
const WALLETS = env('LOAD_WALLETS', 100);
const HOT_SHARE = env('LOAD_HOT_SHARE', 0.8);
const INSTANCES = env('LOAD_INSTANCES', 3);
const OUTPUT = `${import.meta.dir}/../../docs/load-test.md`;
const START = '<!-- results:start -->';
const END = '<!-- results:end -->';

type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND';

interface Sample {
  kind: Kind;
  status: number;
  ms: number;
}

interface PhaseResult {
  name: string;
  wallets: number;
  seconds: number;
  samples: Sample[];
  maxOutboxLagSeconds: number;
  lockTimeouts: number;
  drainSeconds: number;
  inconsistent: number;
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

function pickKind(): Kind {
  const roll = Math.random() * 100;
  if (roll < 70) return 'BET';
  if (roll < 90) return 'WIN';
  if (roll < 95) return 'LOSS';
  return 'REFUND';
}

async function scrape(cluster: Cluster, metric: string): Promise<number[]> {
  const values: number[] = [];
  for (const instance of cluster.instances) {
    try {
      const text = await (await fetch(`${instance.url}/metrics`)).text();
      for (const line of text.split('\n')) {
        if (line.startsWith(`${metric} `) || line.startsWith(`${metric}{`)) values.push(Number(line.split(' ').pop()));
      }
    } catch {
      // instância indisponível: ignora a amostra
    }
  }
  return values;
}

async function runPhase(
  cluster: Cluster,
  orm: Awaited<ReturnType<typeof connect>>,
  name: string,
  wallets: ClusterWallet[],
  hotShare: number,
): Promise<PhaseResult> {
  // BETs processadas por wallet, para os REFUNDs referenciarem algo real.
  const betsOf = new Map<string, WagerBody[]>(wallets.map((wallet) => [wallet.id, []]));
  const samples: Sample[] = [];
  const pickWallet = (): ClusterWallet =>
    Math.random() < hotShare ? wallets[0]! : wallets[Math.floor(Math.random() * wallets.length)]!;

  let measuring = false;
  let running = true;
  const money = { amount: '1.00', currency: 'BRL' };

  const worker = async (): Promise<void> => {
    while (running) {
      const wallet = pickWallet();
      let kind = pickKind();
      const pool = betsOf.get(wallet.id)!;
      let body: WagerBody;
      if (kind === 'REFUND' && pool.length > 0) {
        const reference = pool.pop()!;
        body = wagerBody(wallet, { kind, money, referenceExternalTransactionId: reference.externalTransactionId });
      } else {
        if (kind === 'REFUND') kind = 'BET';
        body = wagerBody(wallet, { kind, money });
      }
      const startedAt = performance.now();
      let status: number;
      try {
        status = (await submit(cluster.next(), body)).status;
      } catch {
        status = 0; // erro de transporte
      }
      const ms = performance.now() - startedAt;
      if (kind === 'BET' && status === 201 && pool.length < 50) pool.push(body);
      if (measuring) samples.push({ kind, status, ms });
    }
  };

  let maxLag = 0;
  const sampler = (async () => {
    while (running) {
      for (const lag of await scrape(cluster, 'outbox_lag_seconds')) if (Number.isFinite(lag)) maxLag = Math.max(maxLag, lag);
      await sleep(1_000);
    }
  })();

  const lockBefore = (await scrape(cluster, 'wallet_lock_timeouts_total')).reduce((a, b) => a + b, 0);
  const workers = Array.from({ length: CONCURRENCY }, worker);
  await sleep(WARMUP_S * 1_000);
  measuring = true;
  const startedAt = performance.now();
  await sleep(DURATION_S * 1_000);
  measuring = false;
  const seconds = (performance.now() - startedAt) / 1_000;
  running = false;
  await Promise.all([...workers, sampler]);
  const lockTimeouts = (await scrape(cluster, 'wallet_lock_timeouts_total')).reduce((a, b) => a + b, 0) - lockBefore;

  // Tempo para a outbox escoar depois do fim da carga.
  const ids = wallets.map((wallet) => wallet.id);
  const drainStart = performance.now();
  for (;;) {
    const [row] = await sql<{ n: string }>(
      orm,
      `SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL AND aggregate_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    if (Number(row!.n) === 0 || performance.now() - drainStart > 120_000) break;
    await sleep(250);
  }
  const drainSeconds = (performance.now() - drainStart) / 1_000;

  // Invariante: toda wallet reconcilia (saldo == ledger, corrente intacta).
  let inconsistent = 0;
  for (const wallet of wallets) {
    const report = await call(cluster.next(), 'POST', `/wallets/${wallet.id}/reconciliation`);
    if (report.status !== 200 || report.body.consistent !== true) inconsistent += 1;
  }

  return { name, wallets: wallets.length, seconds, samples, maxOutboxLagSeconds: maxLag, lockTimeouts, drainSeconds, inconsistent };
}

function renderPhase(result: PhaseResult): string {
  const all = result.samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  for (const sample of result.samples) byStatus.set(sample.status, (byStatus.get(sample.status) ?? 0) + 1);
  const total = result.samples.length;
  const errors = result.samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
  const fmt = (value: number): string => value.toFixed(1);

  const perKind = (['BET', 'WIN', 'LOSS', 'REFUND'] as Kind[])
    .map((kind) => {
      const latencies = result.samples.filter((sample) => sample.kind === kind).map((sample) => sample.ms).sort((a, b) => a - b);
      return `| ${kind} | ${latencies.length} | ${fmt(percentile(latencies, 50))} | ${fmt(percentile(latencies, 95))} | ${fmt(percentile(latencies, 99))} |`;
    })
    .join('\n');
  const statuses = [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, count]) => `| ${status === 0 ? 'transporte (0)' : status} | ${count} | ${((count / total) * 100).toFixed(2)}% |`)
    .join('\n');

  return `### ${result.name}

Wallets: ${result.wallets} · janela medida: ${result.seconds.toFixed(1)} s · requisições: ${total}

| Métrica | Valor |
|---|---|
| Throughput | **${(total / result.seconds).toFixed(0)} req/s** |
| Latência p50 / p95 / p99 | ${fmt(percentile(all, 50))} / ${fmt(percentile(all, 95))} / ${fmt(percentile(all, 99))} ms |
| Taxa de erro (5xx + transporte) | ${((errors / Math.max(total, 1)) * 100).toFixed(2)}% |
| \`wallet_lock_timeouts_total\` (delta) | ${result.lockTimeouts} |
| \`outbox_lag_seconds\` máximo observado | ${result.maxOutboxLagSeconds.toFixed(1)} s |
| Tempo para a outbox escoar após a carga | ${result.drainSeconds.toFixed(1)} s |
| Wallets que falharam na reconciliação | ${result.inconsistent} |

| Status HTTP | Qtde | % |
|---|---|---|
${statuses}

| Operação | Qtde | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|
${perKind}
`;
}

async function main(): Promise<void> {
  await ensureSchema();
  const orm = await connect('app', 5);
  const queues = await createTestQueues();
  const cluster = await Cluster.start(INSTANCES, { queues, env: { LOG_LEVEL: 'error', DB_POOL_MAX: '20' } });
  const [pg] = await sql<{ server_version: string }>(orm, 'SHOW server_version');
  try {
    const opener = () => cluster.next();
    const uniform = await Promise.all(Array.from({ length: WALLETS }, () => openWalletVia(opener(), '1000000.00')));
    const uniformResult = await runPhase(cluster, orm, 'Distribuição uniforme', uniform, 0);

    const hot = await Promise.all(Array.from({ length: WALLETS }, () => openWalletVia(opener(), '1000000.00')));
    const hotResult = await runPhase(cluster, orm, `Hot wallet (${Math.round(HOT_SHARE * 100)}% das operações em uma wallet)`, hot, HOT_SHARE);

    const cpu = cpus();
    const report = `${START}
## Ambiente

| Item | Valor |
|---|---|
| CPU | ${cpu[0]?.model ?? 'n/d'} × ${cpu.length} |
| RAM | ${(totalmem() / 1024 ** 3).toFixed(1)} GiB |
| SO | ${process.platform} ${process.arch} |
| Bun | ${Bun.version} |
| PostgreSQL | ${pg?.server_version ?? 'n/d'} (\`postgres:16-alpine\`, contêiner) |
| LocalStack | \`localstack/localstack:4.4\` (contêiner) |
| Aplicação | ${INSTANCES} processos \`bun src/main.ts\`, pool de 20 conexões cada |
| Gerador de carga | mesmo host (disputa CPU com os processos acima) |
| Data | ${new Date().toISOString()} |

## Metodologia

- Laço fechado: ${CONCURRENCY} clientes concorrentes, cada um envia a próxima requisição ao receber a resposta; HTTP em rodízio entre as instâncias.
- Aquecimento de ${WARMUP_S} s (descartado) e janela fixa de ${DURATION_S} s por cenário.
- Mix: 70% BET, 20% WIN, 5% LOSS, 5% REFUND (de uma BET processada; sem BET disponível, vira BET). Valor fixo de 1.00 BRL e saldo inicial de 1.000.000,00 — o teste mede throughput e latência, não rejeições por saldo.
- Cada operação usa uma \`Idempotency-Key\` nova (não mede replays).
- Ao final de cada cenário: espera a outbox escoar e reconcilia todas as wallets via \`POST /wallets/:id/reconciliation\`.

## Resultados

${renderPhase(uniformResult)}
${renderPhase(hotResult)}
${END}`;

    const file = Bun.file(OUTPUT);
    const existing = (await file.exists()) ? await file.text() : '';
    const next =
      existing.includes(START) && existing.includes(END)
        ? existing.slice(0, existing.indexOf(START)) + report + existing.slice(existing.indexOf(END) + END.length)
        : `# Teste de carga\n\n${report}\n`;
    await Bun.write(OUTPUT, next);
    process.stdout.write(`${report}\n`);
    if (uniformResult.inconsistent + hotResult.inconsistent > 0) process.exitCode = 1;
  } finally {
    await cluster.stop();
    await queues.cleanup();
    await orm.close();
  }
}

await main();
