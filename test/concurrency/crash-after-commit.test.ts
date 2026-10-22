import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Cluster, ServiceInstance } from '../support/cluster.ts';
import {
  assertWalletSound,
  balanceOf,
  ledgerCount,
  openWalletVia,
  sqsEnvelope,
  transactionsOf,
  wagerBody,
  waitQueueDrained,
} from '../support/cluster-fixtures.ts';
import { connect, ensureSchema, sql } from '../support/db.ts';
import { createTestQueues, sendRaw, totalDepth, type TestQueues } from '../support/sqs.ts';
import { waitFor } from '../support/wait.ts';

/**
 * §13.5 — worker morto **depois do commit e antes do ack**. Uma instância com
 * `FAULT_INJECTION=crash_after_commit_before_ack` recebe a mensagem, comita o efeito
 * financeiro e leva `SIGKILL` antes do `DeleteMessage`. Outra instância (sem falha) assume a
 * redelivery: a inbox persistente a reconhece e o efeito permanece único.
 */
let app: MikroORM;
let queues: TestQueues;
let opener: Cluster;

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 5);
  queues = await createTestQueues({ visibilityTimeout: 5 });
  opener = await Cluster.start(1, { queues, env: { SHUTDOWN_GRACE_MS: '1000' } });
}, 120_000);

afterAll(async () => {
  await opener?.stop();
  await queues?.cleanup();
  await app?.close();
});

describe('crash after commit and before ack (real SIGKILL)', () => {
  test('#5 the redelivery hits the inbox: one effect, one inbox row, message acknowledged', async () => {
    const wallet = await openWalletVia(opener.next(), '100.00');
    // A instância "saudável" que abriu a wallet deixa de consumir: só a vítima vê a mensagem.
    await opener.stop();

    const victim = await ServiceInstance.spawn({ queues, fault: 'crash_after_commit_before_ack' });
    let survivor: ServiceInstance | undefined;
    try {
      await victim.waitReady();
      const bet = wagerBody(wallet, { money: { amount: '40.00', currency: 'BRL' } });
      const messageId = `msg-${crypto.randomUUID()}`;
      await sendRaw(queues, sqsEnvelope(bet, messageId), wallet.id);

      // A vítima morre por SIGKILL logo após o commit (sem handlers, sem ack).
      await victim.exited;
      expect(victim.signalCode).toBe('SIGKILL');

      // O efeito já está comitado, e a mensagem continua na fila (não foi apagada).
      expect(await transactionsOf(app, wallet.id)).toEqual([{ status: 'PROCESSED', kind: 'BET', failure_code: null }]);
      expect(await balanceOf(app, wallet.id)).toBe('60.00');
      expect(await totalDepth(queues, queues.wagerUrl)).toBe(1);
      const inbox = await sql(app, 'SELECT message_id FROM inbox_messages WHERE message_id = ?', [messageId]);
      expect(inbox).toHaveLength(1);

      // Outra instância assume: a redelivery cai na inbox e a mensagem é finalmente confirmada.
      survivor = await ServiceInstance.spawn({ queues });
      await survivor.waitReady();
      await waitQueueDrained(() => totalDepth(queues, queues.wagerUrl), 60_000);
      await waitFor(async () => (await totalDepth(queues, queues.dlqUrl)) === 0, { message: 'DLQ to stay empty' });

      expect(await ledgerCount(app, wallet.id, 'DEBIT')).toBe(1);
      expect(await balanceOf(app, wallet.id)).toBe('60.00');
      expect(await sql(app, 'SELECT message_id FROM inbox_messages WHERE message_id = ?', [messageId])).toHaveLength(1);
      await assertWalletSound(app, survivor, wallet.id);
    } finally {
      await victim.kill();
      await survivor?.kill('SIGTERM');
    }
  }, 120_000);
});
