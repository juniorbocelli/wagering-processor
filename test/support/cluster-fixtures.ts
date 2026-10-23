import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Message } from '@aws-sdk/client-sqs';
import { assertLedgerConsistency } from './consistency.ts';
import { call, type Cluster, type HttpResult, type ServiceInstance } from './cluster.ts';
import { sql } from './db.ts';
import { collect, type TestQueues } from './sqs.ts';
import { waitFor } from './wait.ts';

/** Fixtures dos cenários multi-processo: tudo passa pela API HTTP ou pela fila reais. */

export interface ClusterWallet {
  id: string;
  playerId: string;
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

let sequence = 0; // check-money:allow

export async function openWalletVia(instance: ServiceInstance, balance = '100.00'): Promise<ClusterWallet> {
  const playerId = `player-${crypto.randomUUID()}`;
  const response = await call(instance, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount: balance, currency: 'BRL' } },
  });
  expect(response.status).toBe(201);
  return { id: response.body.id as string, playerId };
}

export function wagerBody(wallet: ClusterWallet, over: Partial<WagerBody> = {}): WagerBody {
  sequence += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${crypto.randomUUID()}-${sequence}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...over,
  };
}

export const idempotencyKeyOf = (body: WagerBody): string => `${body.providerId}:${body.externalTransactionId}`;

export function submit(instance: ServiceInstance, body: WagerBody): Promise<HttpResult> {
  return call(instance, 'POST', '/wagering/transactions', {
    body,
    headers: { 'Idempotency-Key': idempotencyKeyOf(body) },
  });
}

/** Mesma forma do `WagerTransactionRequested` (§10); a chave de idempotência é a do corpo. */
export function sqsEnvelope(body: WagerBody, messageId = `msg-${crypto.randomUUID()}`): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: idempotencyKeyOf(body) },
  });
}

export async function ledgerCount(orm: MikroORM, walletId: string, direction?: 'DEBIT' | 'CREDIT'): Promise<number> { // check-money:allow
  const [row] = await sql<{ n: string }>(
    orm,
    direction === undefined
      ? 'SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?'
      : "SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = ?",
    direction === undefined ? [walletId] : [walletId, direction],
  );
  return Number(row!.n);
}

export async function balanceOf(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await sql<{ balance_amount: string }>(orm, 'SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
  return row!.balance_amount;
}

export async function transactionsOf(orm: MikroORM, walletId: string): Promise<{ status: string; kind: string; failure_code: string | null }[]> {
  return sql(orm, 'SELECT status, kind, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind <> ? ORDER BY created_at', [
    walletId,
    'OPENING',
  ]);
}

/** Invariante final (§13) + reconciliação HTTP sobre o mesmo estado. */
export async function assertWalletSound(orm: MikroORM, instance: ServiceInstance, walletId: string): Promise<void> {
  await assertLedgerConsistency(orm, walletId);
  const report = await call(instance, 'POST', `/wallets/${walletId}/reconciliation`);
  expect(report.status).toBe(200);
  expect(report.body.consistent).toBe(true);
}

/** Espera a fila (visíveis + em voo + atrasadas) esvaziar. */
export async function waitQueueDrained(depth: () => Promise<number>, timeoutMs = 40_000): Promise<void> { // check-money:allow
  await waitFor(async () => (await depth()) === 0, { timeoutMs, intervalMs: 250, message: 'the queue to be drained' });
}

export async function outboxPending(orm: MikroORM, walletIds: string[]): Promise<number> { // check-money:allow
  if (walletIds.length === 0) return 0;
  const [row] = await sql<{ n: string }>(
    orm,
    `SELECT count(*)::text AS n FROM outbox_messages
      WHERE published_at IS NULL AND aggregate_id IN (${walletIds.map(() => '?').join(',')})`,
    walletIds,
  );
  return Number(row!.n);
}

export interface ReceivedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  data: { walletVersion?: number };
  raw: string;
}

/**
 * Lê a fila de eventos até todos os `eventId` esperados terem chegado (ou o prazo).
 * Entregas duplicadas permanecem na lista — quem chama decide o que fazer com elas.
 */
export async function receiveEvents(
  queues: TestQueues,
  expectedIds: ReadonlySet<string>,
  timeoutMs = 30_000,
): Promise<ReceivedEvent[]> {
  const parse = (messages: Message[]): ReceivedEvent[] =>
    messages.map((message) => ({ ...(JSON.parse(message.Body ?? '{}') as ReceivedEvent), raw: message.Body ?? '' }));
  const seenExpected = (messages: Message[]): boolean => {
    const seen = new Set(parse(messages).map((event) => event.eventId));
    for (const id of expectedIds) if (!seen.has(id)) return false;
    return true;
  };
  return parse(await collect(queues, queues.eventsUrl, seenExpected, timeoutMs));
}

export async function outboxEventIds(orm: MikroORM, walletIds: string[]): Promise<{ id: string; aggregate_id: string; seq: string }[]> { // check-money:allow
  return sql(
    orm,
    `SELECT id, aggregate_id, seq::text AS seq FROM outbox_messages
      WHERE aggregate_id IN (${walletIds.map(() => '?').join(',')}) ORDER BY outbox_messages.seq`,
    walletIds,
  );
}

/** Garante que o cluster tenha instância viva para diagnóstico e devolve logs em caso de falha. */
export function logsOf(cluster: Cluster): string {
  return cluster.instances.map((instance) => `--- port ${instance.port}\n${instance.logs}`).join('\n');
}
