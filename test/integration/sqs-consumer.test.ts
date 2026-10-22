import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../src/application/errors.ts';
import type { DeadLetterMessage, DeadLetterPublisher } from '../../src/application/ports/messaging.ts';
import type { FaultInjector } from '../../src/application/ports/runtime.ts';
import type {
  ProcessContext,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../src/application/use-cases/process-wager-transaction.ts';
import { SqsDeadLetterPublisher, SqsQueue } from '../../src/infrastructure/messaging/sqs/sqs.ts';
import { buildWageringServices, type WageringServices } from '../../src/infrastructure/wagering-services.ts';
import { UNPARSEABLE_DLQ_GROUP, WagerTransactionConsumer, type WagerConsumerOptions } from '../../src/interfaces/sqs/wager-transaction-consumer.ts';
import { assertLedgerConsistency, CrashOnceFaultInjector } from '../support/consistency.ts';
import { connect, ensureSchema, inTransaction, sql } from '../support/db.ts';
import { collect, createTestQueues, queueDepth, sendRaw, sendWager, totalDepth, wagerMessage, type TestQueues } from '../support/sqs.ts';
import { createFixtures } from '../support/wagering-fixtures.ts';
import { sleep, waitFor } from '../support/wait.ts';

/**
 * Consumidor SQS contra PostgreSQL e LocalStack reais (ADR-004 §3 e §6). Cada teste cria as
 * próprias filas FIFO (com DLQ e redrive) e as próprias wallets.
 */
let app: MikroORM;
let services: WageringServices;

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 30);
  services = buildWageringServices(app);
});

afterAll(async () => {
  await app.close();
});

const { openWallet, cmd, run, txOf, balanceOf, ledgerCount, count } = createFixtures(
  () => app,
  () => services,
);

type UseCase = {
  execute(command: ProcessWagerTransactionCommand, ctx: ProcessContext): Promise<ProcessWagerTransactionResult>;
};

const FAST: Partial<WagerConsumerOptions> = {
  waitTimeSeconds: 1,
  heartbeatIntervalMs: 60_000,
  gracePeriodMs: 5_000,
  retryBaseSeconds: 1,
  retryCapSeconds: 2,
};

let queues: TestQueues;
const consumers: WagerTransactionConsumer[] = [];

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((consumer) => consumer.stop()));
  await queues?.cleanup();
});

function consumerFor(
  useCase: UseCase,
  over: { options?: Partial<WagerConsumerOptions>; faults?: FaultInjector; deadLetters?: DeadLetterPublisher } = {},
): WagerTransactionConsumer {
  const consumer = new WagerTransactionConsumer({
    queue: new SqsQueue(queues.client, queues.wagerUrl),
    deadLetters: over.deadLetters ?? new SqsDeadLetterPublisher(queues.client, queues.dlqUrl),
    useCase,
    options: { ...FAST, ...over.options },
    ...(over.faults === undefined ? {} : { faults: over.faults }),
  });
  consumers.push(consumer);
  return consumer;
}

const real = (): UseCase => services.processWagerTransaction;
/**
 * Fila vazia de forma estável: os atributos `ApproximateNumberOfMessages*` são eventualmente
 * consistentes, então um único zero logo após o envio não prova nada. Exige zeros seguidos.
 */
const drained = async (): Promise<boolean> => {
  for (let i = 0; i < 3; i += 1) {
    if ((await totalDepth(queues, queues.wagerUrl)) !== 0) return false;
    await sleep(300);
  }
  return true;
};

describe('SQS consumer (PostgreSQL + LocalStack reais)', () => {
  test('redelivery of the same message: one effect, both deliveries acknowledged', async () => {
    queues = await createTestQueues();
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);

    await sendWager(queues, message);
    await sendWager(queues, message); // mesma mensagem lógica (mesmo messageId), entrega duplicada
    consumerFor(real()).start();

    await waitFor(drained, { message: 'queue to drain' });
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await count('inbox_messages', 'message_id = ?', [message.messageId])).toBe(1);
    expect(await totalDepth(queues, queues.dlqUrl)).toBe(0);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('same operation via use case (HTTP path) and via SQS is a replay: one effect', async () => {
    queues = await createTestQueues();
    const wallet = await openWallet('100.00');
    const command = cmd(wallet);
    expect(txOf(await run(command)).status).toBe('PROCESSED');

    // O mesmo negócio chega pela fila com outro messageId: replay por idempotência.
    await sendWager(
      queues,
      wagerMessage(wallet, {
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
      }),
    );
    consumerFor(real()).start();

    await waitFor(drained, { message: 'queue to drain' });
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await count('wager_transactions', 'wallet_id = ? AND kind = ?', [wallet.id, 'BET'])).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('the reverse order (SQS first, then the use case) is also a replay', async () => {
    queues = await createTestQueues();
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    await sendWager(queues, message);
    consumerFor(real()).start();
    await waitFor(drained, { message: 'queue to drain' });

    const again = txOf(
      await run(
        cmd(wallet, {
          externalTransactionId: message.data.externalTransactionId,
          idempotencyKey: message.data.idempotencyKey,
        }),
      ),
    );
    expect(again.status).toBe('PROCESSED');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('90.00');
    await assertLedgerConsistency(app, wallet.id);
  });

  test('crash after commit and before ack: the redelivery is absorbed by the inbox (one effect)', async () => {
    queues = await createTestQueues({ visibilityTimeout: 2 });
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    const faults = new CrashOnceFaultInjector();
    faults.arm('crash_after_commit_before_ack');

    await sendWager(queues, message);
    const victim = consumerFor(real(), { faults, options: { visibilityTimeoutSeconds: 2 } });
    victim.start();
    await waitFor(() => victim.crashed, { message: 'simulated crash' });
    expect(await balanceOf(wallet.id)).toBe('90.00'); // o commit aconteceu
    expect((await queueDepth(queues, queues.wagerUrl)).inFlight).toBe(1); // sem ack

    consumerFor(real(), { options: { visibilityTimeoutSeconds: 2 } }).start(); // outra instância
    await waitFor(drained, { message: 'redelivery to be acknowledged' });
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('transient error (lock timeout on the wallet): retried with backoff, then it succeeds', async () => {
    queues = await createTestQueues();
    const strict = buildWageringServices(app, { unitOfWork: { lockTimeout: '300ms', statementTimeout: '5s' } });
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    await sendWager(queues, message);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    // Outra transação segura o lock da wallet: o processamento estoura o lock_timeout (55P03).
    const holder = inTransaction(app, async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      locked();
      await held;
    });
    await isLocked;

    consumerFor(strict.processWagerTransaction).start();
    await sleep(1_500);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(0); // falhou, não apagou a mensagem
    expect(await totalDepth(queues, queues.wagerUrl)).toBe(1);

    release();
    await holder;
    await waitFor(drained, { timeoutMs: 20_000, message: 'retry to succeed' });
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await totalDepth(queues, queues.dlqUrl)).toBe(0);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('permanent error (unknown wallet): DLQ with the original body and the error attributes', async () => {
    queues = await createTestQueues();
    const ghost = { id: crypto.randomUUID(), playerId: 'player-ghost' };
    const message = wagerMessage(ghost);
    await sendWager(queues, message);
    consumerFor(real()).start();

    const [dead] = await collect(queues, queues.dlqUrl, (got) => got.length >= 1);
    expect(dead).toBeDefined();
    expect(dead!.Body).toBe(JSON.stringify(message));
    expect(dead!.MessageAttributes?.['errorCode']?.StringValue).toBe('WALLET_NOT_FOUND');
    expect(dead!.MessageAttributes?.['sourceMessageId']?.StringValue).toBeTruthy();
    expect(dead!.MessageAttributes?.['failedAt']?.StringValue).toBeTruthy();
    await waitFor(drained, { message: 'source queue to be empty' });
  });

  test('permanent error (same idempotency key, different payload): DLQ, no second effect', async () => {
    queues = await createTestQueues();
    const wallet = await openWallet('100.00');
    const first = wagerMessage(wallet);
    await sendWager(queues, first);
    consumerFor(real()).start();
    await waitFor(drained, { message: 'first message' });

    const conflicting = wagerMessage(wallet, {
      externalTransactionId: first.data.externalTransactionId,
      idempotencyKey: first.data.idempotencyKey,
      money: { amount: '55.00', currency: 'BRL' },
    });
    await sendWager(queues, conflicting);
    const [dead] = await collect(queues, queues.dlqUrl, (got) => got.length >= 1);
    expect(dead?.MessageAttributes?.['errorCode']?.StringValue).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('persistent transient failure: the redrive policy moves it to the DLQ after maxReceiveCount', async () => {
    queues = await createTestQueues({ visibilityTimeout: 2, maxReceiveCount: 2 });
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wallet);
    await sendWager(queues, message);

    let attempts = 0;
    const failing: UseCase = {
      execute: () => {
        attempts += 1;
        return Promise.reject(new TransientInfrastructureError('database unavailable'));
      },
    };
    consumerFor(failing, { options: { visibilityTimeoutSeconds: 2 } }).start();

    const [dead] = await collect(queues, queues.dlqUrl, (got) => got.length >= 1, 30_000);
    expect(dead?.Body).toBe(JSON.stringify(message));
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(0);
  });

  test('non-JSON body: DLQ with the original body and errorCode=VALIDATION_ERROR', async () => {
    queues = await createTestQueues();
    await sendRaw(queues, '{not json at all', crypto.randomUUID());
    consumerFor(real()).start();

    const [dead] = await collect(queues, queues.dlqUrl, (got) => got.length >= 1);
    expect(dead?.Body).toBe('{not json at all');
    expect(dead?.MessageAttributes?.['errorCode']?.StringValue).toBe('VALIDATION_ERROR');
    await waitFor(drained, { message: 'source queue to be empty' });
  });

  test('a body without a group is dead-lettered under the unparseable group', async () => {
    queues = await createTestQueues();
    await sendRaw(queues, JSON.stringify({ messageId: 'x', type: 'Other' }), UNPARSEABLE_DLQ_GROUP);
    consumerFor(real()).start();
    const [dead] = await collect(queues, queues.dlqUrl, (got) => got.length >= 1);
    expect(dead?.MessageAttributes?.['errorCode']?.StringValue).toBe('VALIDATION_ERROR');
  });

  test('DLQ unavailable: the message is NOT deleted', async () => {
    queues = await createTestQueues({ visibilityTimeout: 2, maxReceiveCount: 50 });
    const attempted: DeadLetterMessage[] = [];
    const brokenDlq: DeadLetterPublisher = {
      send: (message) => {
        attempted.push(message);
        return Promise.reject(new Error('DLQ unavailable'));
      },
    };
    await sendRaw(queues, 'garbage', crypto.randomUUID());
    consumerFor(real(), { deadLetters: brokenDlq, options: { visibilityTimeoutSeconds: 2 } }).start();

    await waitFor(() => attempted.length >= 1, { message: 'a dead-letter attempt' });
    await sleep(1_500);
    expect(await totalDepth(queues, queues.wagerUrl)).toBe(1); // continua na fila
    expect(await totalDepth(queues, queues.dlqUrl)).toBe(0);
  });

  test('same FIFO group, transient failure on the first message: order preserved without waiting for the visibility timeout', async () => {
    queues = await createTestQueues({ visibilityTimeout: 30 });
    const wallet = await openWallet('100.00');
    const messages = [1, 2, 3].map((n) => wagerMessage(wallet, { externalTransactionId: `ordered-${crypto.randomUUID()}-${n}` }));
    for (const message of messages) await sendWager(queues, message);

    const order: string[] = [];
    let failedOnce = false;
    const flaky: UseCase = {
      execute: async (command, ctx) => {
        if (!failedOnce && command.externalTransactionId === messages[0]!.data.externalTransactionId) {
          failedOnce = true;
          throw new TransientInfrastructureError('first attempt fails');
        }
        const result = await services.processWagerTransaction.execute(command, ctx);
        order.push(command.externalTransactionId);
        return result;
      },
    };
    const started = Date.now();
    consumerFor(flaky, { options: { visibilityTimeoutSeconds: 30 } }).start();

    await waitFor(() => order.length === 3, { timeoutMs: 20_000, message: 'three messages processed' });
    expect(order).toEqual(messages.map((message) => message.data.externalTransactionId));
    expect(Date.now() - started).toBeLessThan(20_000); // bem abaixo do visibility timeout de 30 s
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await assertLedgerConsistency(app, wallet.id);
  });

  test('SIGTERM with a message in flight: it is finished inside the grace period', async () => {
    queues = await createTestQueues();
    const wallet = await openWallet('100.00');
    await sendWager(queues, wagerMessage(wallet));

    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const slow: UseCase = {
      execute: async (command, ctx) => {
        started();
        await sleep(1_000);
        return services.processWagerTransaction.execute(command, ctx);
      },
    };
    const consumer = consumerFor(slow, { options: { gracePeriodMs: 8_000 } });
    consumer.start();
    await begun;
    await consumer.stop(); // SIGTERM

    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await totalDepth(queues, queues.wagerUrl)).toBe(0); // confirmada, não devolvida
    await assertLedgerConsistency(app, wallet.id);
  });

  test('SIGTERM when the grace period expires: the message goes back with visibility 0 and is absorbed once', async () => {
    queues = await createTestQueues();
    const wallet = await openWallet('100.00');
    await sendWager(queues, wagerMessage(wallet));

    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const stuck: UseCase = {
      execute: async () => {
        started();
        await sleep(60_000);
        throw new Error('never reached');
      },
    };
    const consumer = consumerFor(stuck, { options: { gracePeriodMs: 300 } });
    consumer.start();
    await begun;
    await consumer.stop();

    // Visível de novo imediatamente (visibilidade 0), sem esperar os 30 s da fila.
    await waitFor(async () => (await queueDepth(queues, queues.wagerUrl)).visible === 1, {
      timeoutMs: 5_000,
      message: 'message to be visible again',
    });

    consumerFor(real()).start(); // a próxima instância conclui
    await waitFor(drained, { message: 'queue to drain' });
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await assertLedgerConsistency(app, wallet.id);
  });

  test('independent wallets are processed concurrently and none loses its effect', async () => {
    queues = await createTestQueues();
    const wallets = await Promise.all([openWallet('100.00'), openWallet('100.00'), openWallet('100.00')]);
    for (const wallet of wallets) {
      for (let i = 0; i < 3; i += 1) await sendWager(queues, wagerMessage(wallet));
    }
    consumerFor(real()).start();
    consumerFor(real()).start();

    await waitFor(drained, { timeoutMs: 30_000, message: 'queue to drain' });
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('70.00');
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(3);
      await assertLedgerConsistency(app, wallet.id);
    }
    const [row] = await sql<{ n: string }>(app, 'SELECT count(*)::text AS n FROM inbox_messages WHERE consumer_name = ?', ['wager-transactions']);
    expect(Number(row!.n)).toBeGreaterThanOrEqual(9);
  });
});
