import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Cluster, type HttpResult } from '../support/cluster.ts';
import {
  assertWalletSound,
  balanceOf,
  ledgerCount,
  openWalletVia,
  outboxPending,
  sqsEnvelope,
  submit,
  wagerBody,
  waitQueueDrained,
  type ClusterWallet,
  type WagerBody,
} from '../support/cluster-fixtures.ts';
import { connect, ensureSchema } from '../support/db.ts';
import { createTestQueues, sendRaw, totalDepth, type TestQueues } from '../support/sqs.ts';
import { waitFor } from '../support/wait.ts';

/**
 * §13.8 — reinício do serviço com prova da consistência final. As 3 instâncias levam
 * `SIGKILL` no meio de uma carga mista (HTTP + SQS) e são reiniciadas sobre o mesmo banco e
 * as mesmas filas. Provas: idempotência persistente (reenvio devolve a resposta original),
 * inbox/SQS sem efeito duplicado, outbox drenada e reconciliação `consistent: true`.
 */
const WALLETS = 20; // check-money:allow
const HTTP_BETS_PER_WALLET = 15; // check-money:allow
const SQS_BETS_PER_WALLET = 5; // check-money:allow
const KILL_AFTER_RESPONSES = 120; // check-money:allow
const IN_FLIGHT = 24; // check-money:allow

let app: MikroORM;
let queues: TestQueues;
let cluster: Cluster;

beforeAll(async () => {
  await ensureSchema();
  app = await connect('app', 5);
  queues = await createTestQueues({ visibilityTimeout: 5 });
  cluster = await Cluster.start(3, { queues });
}, 120_000);

afterAll(async () => {
  await cluster?.stop();
  await queues?.cleanup();
  await app?.close();
});

interface HttpOp {
  body: WagerBody;
  answered?: HttpResult;
}

describe('restart recovery (SIGKILL of all instances mid-load)', () => {
  test('#8 after the restart every wallet reconciles, the outbox drains and replays return the original answers', async () => {
    const wallets: ClusterWallet[] = await Promise.all(
      Array.from({ length: WALLETS }, () => openWalletVia(cluster.next(), '1000.00')),
    );
    const bet = (wallet: ClusterWallet) => wagerBody(wallet, { money: { amount: '1.00', currency: 'BRL' } });

    const httpOps: HttpOp[] = wallets.flatMap((wallet) =>
      Array.from({ length: HTTP_BETS_PER_WALLET }, () => ({ body: bet(wallet) })),
    );
    const sqsBodies = wallets.flatMap((wallet) => Array.from({ length: SQS_BETS_PER_WALLET }, () => bet(wallet)));

    // Mensagens SQS já na fila antes da carga HTTP (várias ficam em voo/pendentes na hora do kill).
    await Promise.all(sqsBodies.map((body) => sendRaw(queues, sqsEnvelope(body), body.walletId)));

    // Carga HTTP com janela de concorrência; `SIGKILL` geral assim que houver respostas suficientes.
    let cursor = 0; // check-money:allow
    let answered = 0; // check-money:allow
    let killed = false;
    let killing: Promise<void> | undefined;
    const worker = async (): Promise<void> => {
      while (!killed && cursor < httpOps.length) {
        const op = httpOps[cursor]!;
        cursor += 1;
        try {
          op.answered = await submit(cluster.next(), op.body);
          answered += 1;
          if (answered >= KILL_AFTER_RESPONSES && killing === undefined) {
            killed = true;
            killing = cluster.killAll('SIGKILL');
          }
        } catch {
          // conexão derrubada no meio da requisição: resultado desconhecido (reenviado depois)
        }
      }
    };
    await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
    await killing;
    expect(killed).toBe(true);
    expect(cluster.instances.every((instance) => !instance.alive)).toBe(true);

    await cluster.restartAll();

    // Idempotência persistente: o reenvio de TUDO (inclusive o que nunca foi enviado) é seguro.
    const resent = await Promise.all(httpOps.map((op) => submit(cluster.next(), op.body)));
    httpOps.forEach((op, index) => {
      const again = resent[index]!;
      expect([200, 201]).toContain(again.status);
      expect(again.body.status).toBe('PROCESSED');
      if (op.answered !== undefined) {
        // Já respondida antes do kill: agora é replay fiel da resposta original.
        expect(again.status).toBe(200);
        expect(again.body.idempotentReplay).toBe(true);
        expect(again.body.transactionId).toBe(op.answered.body.transactionId);
        expect(again.body.balance).toEqual(op.answered.body.balance);
      }
    });

    // As mensagens SQS interrompidas são redelivered e confirmadas; nada vai para a DLQ.
    await waitQueueDrained(() => totalDepth(queues, queues.wagerUrl), 90_000);
    expect(await totalDepth(queues, queues.dlqUrl)).toBe(0);
    const replayedSqs = await Promise.all(sqsBodies.map((body) => submit(cluster.next(), body)));
    expect(replayedSqs.every((result) => result.status === 200 && result.body.idempotentReplay === true)).toBe(true);

    // A outbox é drenada pelas instâncias novas (leases das mortas expiram).
    const ids = wallets.map((wallet) => wallet.id);
    await waitFor(async () => (await outboxPending(app, ids)) === 0, {
      timeoutMs: 60_000,
      intervalMs: 300,
      message: 'the outbox to be drained after the restart',
    });

    // Consistência final: um único efeito por operação, saldo = ledger, reconciliação íntegra.
    for (const wallet of wallets) {
      expect(await ledgerCount(app, wallet.id, 'DEBIT')).toBe(HTTP_BETS_PER_WALLET + SQS_BETS_PER_WALLET);
      expect(await balanceOf(app, wallet.id)).toBe('980.00');
      await assertWalletSound(app, cluster.next(), wallet.id);
    }
  }, 240_000);
});
