import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Cluster, barrier, call } from '../support/cluster.ts';
import {
  assertWalletSound,
  balanceOf,
  ledgerCount,
  logsOf,
  openWalletVia,
  outboxEventIds,
  outboxPending,
  receiveEvents,
  sqsEnvelope,
  submit,
  transactionsOf,
  wagerBody,
  waitQueueDrained,
} from '../support/cluster-fixtures.ts';
import { connect, ensureSchema, sql } from '../support/db.ts';
import { createTestQueues, queueDepth, sendRaw, totalDepth, type TestQueues } from '../support/sqs.ts';
import { waitFor } from '../support/wait.ts';

/**
 * §13 — concorrência com paralelismo real: 3 processos `bun src/main.ts` sobre o mesmo
 * PostgreSQL e o mesmo LocalStack (nada mockado). Requisições HTTP em rodízio entre as
 * instâncias, mensagens SQS consumidas por todas, largada sincronizada por barreira.
 * Cada teste cria as próprias wallets (UUIDv7) — nenhuma tabela é truncada.
 */
const INSTANCES = 3; // check-money:allow

let app: MikroORM;
let queues: TestQueues;
let cluster: Cluster;

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 5);
  queues = await createTestQueues({ visibilityTimeout: 5 });
  cluster = await Cluster.start(INSTANCES, { queues });
}, 120_000);

afterAll(async () => {
  await cluster?.stop();
  await queues?.cleanup();
  await app?.close();
});

describe('concurrency (3 processes, real PostgreSQL + LocalStack)', () => {
  test('#1 the same BET 50× in parallel (HTTP on 3 instances + SQS): one PROCESSED, 49 replays, one DEBIT', async () => {
    const wallet = await openWalletVia(cluster.next(), '100.00');
    const bet = wagerBody(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    const HTTP_CALLS = 40; // check-money:allow
    const SQS_MESSAGES = 10; // check-money:allow
    const start = barrier();
    const http = Array.from({ length: HTTP_CALLS }, () => {
      const instance = cluster.next();
      return start.wait.then(() => submit(instance, bet));
    });
    const sqs = Array.from({ length: SQS_MESSAGES }, () =>
      start.wait.then(() => sendRaw(queues, sqsEnvelope(bet), wallet.id)),
    );
    start.open();
    const responses = await Promise.all(http);
    await Promise.all(sqs);

    // HTTP: no máximo uma resposta de criação (a SQS pode ter vencido a corrida); o resto é replay.
    const created = responses.filter((response) => response.status === 201);
    const replays = responses.filter((response) => response.status === 200);
    expect(created.length).toBeLessThanOrEqual(1);
    expect(created.length + replays.length).toBe(HTTP_CALLS);
    for (const replay of replays) {
      expect(replay.body.idempotentReplay).toBe(true);
      expect(replay.body.status).toBe('PROCESSED');
    }
    expect(new Set(responses.map((response) => response.body.transactionId as string)).size).toBe(1);

    await waitQueueDrained(() => totalDepth(queues, queues.wagerUrl));
    expect(await totalDepth(queues, queues.dlqUrl)).toBe(0);

    // Um único efeito, qualquer que seja o canal vencedor.
    expect(await transactionsOf(app, wallet.id)).toEqual([{ status: 'PROCESSED', kind: 'BET', failure_code: null }]);
    expect(await ledgerCount(app, wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(app, wallet.id)).toBe('75.00');
    await assertWalletSound(app, cluster.next(), wallet.id);
  });

  test('#2 §8 scenario: balance 100, two BET of 80 at once on different instances (×20)', async () => {
    for (let round = 0; round < 20; round += 1) {
      const wallet = await openWalletVia(cluster.next(), '100.00');
      const start = barrier();
      const a = wagerBody(wallet, { money: { amount: '80.00', currency: 'BRL' } });
      const b = wagerBody(wallet, { money: { amount: '80.00', currency: 'BRL' } });
      const instanceA = cluster.at(round);
      const instanceB = cluster.at(round + 1);
      const pair = [
        start.wait.then(() => submit(instanceA, a)),
        start.wait.then(() => submit(instanceB, b)),
      ];
      start.open();
      const results = await Promise.all(pair);

      expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
      const rejected = results.find((result) => result.status === 422)!;
      expect(rejected.body.status).toBe('REJECTED');
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(app, wallet.id)).toBe('20.00');
      expect(await ledgerCount(app, wallet.id, 'DEBIT')).toBe(1);
      expect(await ledgerCount(app, wallet.id)).toBe(2); // OPENING + 1 débito; a rejeitada não gera lançamento
      await assertWalletSound(app, cluster.next(), wallet.id);
    }
  }, 90_000);

  test('#3 200 distinct wallets in parallel: all consistent, and far faster than serial (no global lock)', async () => {
    const WALLETS = 200; // check-money:allow
    const OPS_PER_WALLET = 2; // check-money:allow

    // Linha de base serial: custo médio de uma operação sobre uma wallet isolada.
    const baseline = await openWalletVia(cluster.next(), '1000.00');
    const SAMPLES = 20; // check-money:allow
    const serialStart = performance.now();
    for (let index = 0; index < SAMPLES; index += 1) {
      expect((await submit(cluster.next(), wagerBody(baseline, { money: { amount: '1.00', currency: 'BRL' } }))).status).toBe(201);
    }
    const perOperationMs = (performance.now() - serialStart) / SAMPLES;

    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => openWalletVia(cluster.next(), '100.00')));
    const start = barrier();
    const startedAt = { value: 0 };
    const jobs = wallets.flatMap((wallet) => [
      wagerBody(wallet, { kind: 'BET', money: { amount: '30.00', currency: 'BRL' } }),
      wagerBody(wallet, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } }),
    ].map((body) => ({ body, instance: cluster.next() })));
    const pending = jobs.map(({ body, instance }) => start.wait.then(() => submit(instance, body)));
    start.open();
    startedAt.value = performance.now();
    const results = await Promise.all(pending);
    const parallelMs = performance.now() - startedAt.value;

    expect(results.every((result) => result.status === 201)).toBe(true);
    // Mesmo em hardware modesto, 400 operações em paralelo têm de custar bem menos que 400 seriais.
    const serialEstimateMs = perOperationMs * WALLETS * OPS_PER_WALLET;
    expect(parallelMs).toBeLessThan(serialEstimateMs * 0.6);

    for (const wallet of wallets) {
      expect(await balanceOf(app, wallet.id)).toBe('75.00'); // 100 − 30 + 5
    }
    await Promise.all(wallets.map((wallet) => assertWalletSound(app, cluster.next(), wallet.id)));
  }, 120_000);

  test('#4 hot wallet: 50 mixed operations on 3 instances — never negative, version = last ledger version, chain intact', async () => {
    const wallet = await openWalletVia(cluster.next(), '100.00');

    // Pré-condições para reversões: BETs e um WIN já processados (ordem serial, conhecida).
    const priorBets = [] as ReturnType<typeof wagerBody>[];
    for (let index = 0; index < 3; index += 1) {
      const bet = wagerBody(wallet, { money: { amount: '10.00', currency: 'BRL' } });
      expect((await submit(cluster.next(), bet)).status).toBe(201);
      priorBets.push(bet);
    }
    const priorWin = wagerBody(wallet, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } });
    expect((await submit(cluster.next(), priorWin)).status).toBe(201);

    const money = (amount: string) => ({ amount, currency: 'BRL' });
    const operations = [
      ...Array.from({ length: 20 }, () => wagerBody(wallet, { kind: 'BET', money: money('10.00') })),
      ...Array.from({ length: 6 }, () => wagerBody(wallet, { kind: 'BET', money: money('3.50') })),
      ...Array.from({ length: 15 }, () => wagerBody(wallet, { kind: 'WIN', money: money('5.00') })),
      ...Array.from({ length: 5 }, () => wagerBody(wallet, { kind: 'LOSS', money: money('1.00') })),
      wagerBody(wallet, { kind: 'REFUND', money: money('10.00'), referenceExternalTransactionId: priorBets[0]!.externalTransactionId }),
      wagerBody(wallet, { kind: 'REFUND', money: money('10.00'), referenceExternalTransactionId: priorBets[1]!.externalTransactionId }),
      wagerBody(wallet, { kind: 'ROLLBACK', money: money('10.00'), referenceExternalTransactionId: priorBets[2]!.externalTransactionId }),
      wagerBody(wallet, { kind: 'ROLLBACK', money: money('5.00'), referenceExternalTransactionId: priorWin.externalTransactionId }),
    ];
    expect(operations).toHaveLength(50);

    const start = barrier();
    const pending = operations.map((body) => {
      const instance = cluster.next();
      return start.wait.then(() => submit(instance, body));
    });
    start.open();
    const results = await Promise.all(pending);

    for (const result of results) {
      expect([201, 422]).toContain(result.status); // sem 5xx, sem 409, sem PENDING
      if (result.status === 422) {
        expect(['INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS']).toContain(result.body.failureCode as string);
      }
    }
    expect(await sql(app, 'SELECT ?::numeric >= 0 AS non_negative', [await balanceOf(app, wallet.id)])).toEqual([{ non_negative: true }]);
    await assertWalletSound(app, cluster.next(), wallet.id); // inclui version == último wallet_version e a corrente
  }, 90_000);

  test('#6 outbox with concurrent publishers (3 instances): all events published ≥ 1×, duplicates only share eventId, per-wallet order kept', async () => {
    const WALLETS = 8; // check-money:allow
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => openWalletVia(cluster.next(), '500.00')));
    const start = barrier();
    const pending = wallets.flatMap((wallet) =>
      Array.from({ length: 5 }, (_unused, index) => {
        const instance = cluster.next();
        const body = wagerBody(wallet, {
          kind: index % 2 === 0 ? 'BET' : 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
        });
        return start.wait.then(() => submit(instance, body));
      }),
    );
    start.open();
    expect((await Promise.all(pending)).every((result) => result.status === 201)).toBe(true);

    const ids = wallets.map((wallet) => wallet.id);
    const expected = await outboxEventIds(app, ids);
    expect(expected.length).toBeGreaterThanOrEqual(WALLETS * 5);
    await waitFor(async () => (await outboxPending(app, ids)) === 0, {
      timeoutMs: 40_000,
      intervalMs: 250,
      message: 'every outbox event to be published',
    });

    const received = (await receiveEvents(queues, new Set(expected.map((row) => row.id)))).filter((event) => ids.includes(event.aggregateId));
    // nada perdido
    expect(new Set(received.map((event) => event.eventId))).toEqual(new Set(expected.map((row) => row.id)));
    // duplicatas só com o mesmo eventId e corpo idêntico
    const bodies = new Map<string, string>();
    for (const event of received) {
      expect(bodies.get(event.eventId) ?? event.raw).toBe(event.raw);
      bodies.set(event.eventId, event.raw);
    }
    // ordem por wallet = ordem de `seq` (ignorando duplicatas)
    for (const wallet of wallets) {
      const inSeq = expected.filter((row) => row.aggregate_id === wallet.id).map((row) => row.id);
      const arrival = [...new Set(received.filter((event) => event.aggregateId === wallet.id).map((event) => event.eventId))];
      expect(arrival).toEqual(inSeq);
      await assertWalletSound(app, cluster.next(), wallet.id);
    }
    const [stuck] = await sql<{ n: string }>(
      app,
      `SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_id IN (${ids.map(() => '?').join(',')}) AND published_at IS NULL`,
      ids,
    );
    expect(Number(stuck!.n)).toBe(0);
  }, 90_000);

  test('#7 REFUND (HTTP) and ROLLBACK (SQS) before their references: PENDING_REFERENCE → PROCESSED once the references arrive', async () => {
    const wallet = await openWalletVia(cluster.next(), '100.00');
    const bet = wagerBody(wallet, { kind: 'BET', money: { amount: '30.00', currency: 'BRL' } });
    const win = wagerBody(wallet, { kind: 'WIN', money: { amount: '7.00', currency: 'BRL' } });
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = wagerBody(wallet, {
      kind: 'ROLLBACK',
      money: { amount: '7.00', currency: 'BRL' },
      referenceExternalTransactionId: win.externalTransactionId,
    });

    // As reversões chegam antes das referências.
    const early = await submit(cluster.next(), refund);
    expect(early.status).toBe(202);
    expect(early.body.status).toBe('PENDING_REFERENCE');
    await sendRaw(queues, sqsEnvelope(rollback), wallet.id);
    const lookup = () => call(cluster.next(), 'GET', `/providers/provider-a/wagering/transactions/${rollback.externalTransactionId}`);
    await waitFor(async () => (await lookup()).body?.status === 'PENDING_REFERENCE', { message: 'ROLLBACK to be parked' });
    expect(await balanceOf(app, wallet.id)).toBe('100.00');

    // Agora as referências.
    expect((await submit(cluster.next(), bet)).status).toBe(201);
    expect((await submit(cluster.next(), win)).status).toBe(201);

    const statusOf = async (externalId: string) =>
      (await call(cluster.next(), 'GET', `/providers/provider-a/wagering/transactions/${externalId}`)).body?.status as string | undefined;
    await waitFor(
      async () => (await statusOf(refund.externalTransactionId)) === 'PROCESSED' && (await statusOf(rollback.externalTransactionId)) === 'PROCESSED',
      { timeoutMs: 30_000, message: 'both reversals to be applied' },
    );

    // 100 − 30 (BET) + 7 (WIN) + 30 (REFUND) − 7 (ROLLBACK de um WIN) = 100
    expect(await balanceOf(app, wallet.id)).toBe('100.00');
    expect(await ledgerCount(app, wallet.id)).toBe(5); // OPENING + 4 movimentos
    await assertWalletSound(app, cluster.next(), wallet.id);
    await waitQueueDrained(() => totalDepth(queues, queues.wagerUrl));
    expect(await queueDepth(queues, queues.dlqUrl)).toEqual({ visible: 0, inFlight: 0, delayed: 0 });
  }, 90_000);

  test('diagnostics: no instance logged an error during the scenarios', () => {
    const errors = logsOf(cluster).split('\n').filter((line) => /"level":50|"level":"error"/.test(line));
    expect(errors, logsOf(cluster)).toEqual([]);
  });
});
