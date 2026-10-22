import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  ClaimedOutboxMessage,
  ClaimOutboxInput,
  OutboxStore,
  PendingReferenceScanner,
  RetentionStore,
} from '../../../application/ports/messaging.ts';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.ts';
import { mapDriverError } from './driver-errors.ts';

interface OutboxRow {
  id: string;
  seq: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  locked_until: Date | null;
  locked_by: string | null;
  published_at: Date | null;
  last_error: string | null;
}

const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

/**
 * Operações de mensageria que **não** participam da transação financeira: claim/ack da
 * outbox (ADR-004 §4), varredura de referências pendentes (§5) e retenção (ADR-011).
 * Cada método é um único statement em autocommit sobre um `fork` próprio — nenhuma
 * conexão fica presa durante chamadas de rede.
 */
export class MikroOrmMessagingStore implements OutboxStore, PendingReferenceScanner, RetentionStore {
  constructor(private readonly orm: MikroORM) {}

  async claim(input: ClaimOutboxInput): Promise<ClaimedOutboxMessage[]> {
    const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
    const rows = await this.query<OutboxRow>(
      // 1) `heads`: a CABEÇA (pendente mais antigo) de cada wallet livre; `SKIP LOCKED` deixa N
      //    publishers concorrentes sem bloqueio mútuo.  2) `batch`: a cabeça e os seguintes da
      //    mesma wallet.  3) lease em todos; nenhum outro publisher alcança a wallet enquanto a
      //    cabeça estiver com lease ou em backoff (ordem por wallet preservada).
      `WITH heads AS (
         SELECT o.aggregate_id, o.seq
           FROM outbox_messages o
          WHERE o.published_at IS NULL
            AND o.next_attempt_at <= ?
            AND (o.locked_until IS NULL OR o.locked_until < ?)
            AND NOT EXISTS (
              SELECT 1 FROM outbox_messages p
               WHERE p.aggregate_id = o.aggregate_id AND p.published_at IS NULL AND p.seq < o.seq)
          ORDER BY o.seq
          LIMIT ?
            FOR UPDATE OF o SKIP LOCKED
       ), batch AS (
         SELECT f.id FROM heads h
          CROSS JOIN LATERAL (
            SELECT m.id FROM outbox_messages m
             WHERE m.aggregate_id = h.aggregate_id AND m.published_at IS NULL AND m.seq >= h.seq
             ORDER BY m.seq
             LIMIT ?) f
       )
       UPDATE outbox_messages u
          SET locked_until = ?, locked_by = ?
        WHERE u.id IN (SELECT id FROM batch)
       RETURNING u.id, u.seq::text AS seq, u.aggregate_id, u.event_type, u.event_version, u.payload,
                 u.occurred_at, u.attempts, u.next_attempt_at, u.locked_until, u.locked_by,
                 u.published_at, u.last_error`,
      [input.now, input.now, input.headLimit, input.perWalletLimit, leaseUntil, input.instanceId],
    );
    return rows
      .map((row) => ({ seq: BigInt(row.seq), message: toMessage(row) }))
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  }

  async markPublished(ids: readonly string[], instanceId: string, at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    return this.run(
      `UPDATE outbox_messages
          SET published_at = ?, locked_until = NULL, locked_by = NULL, last_error = NULL
        WHERE id IN (${placeholders(ids.length)}) AND locked_by = ? AND published_at IS NULL`,
      [at, ...ids, instanceId],
    );
  }

  async saveRetry(message: OutboxMessage, instanceId: string): Promise<void> {
    await this.run(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, locked_until = NULL, locked_by = NULL, last_error = ?
        WHERE id = ? AND locked_by = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt, message.lastError ?? null, message.id, instanceId],
    );
  }

  async releaseLease(ids: readonly string[], instanceId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.run(
      `UPDATE outbox_messages
          SET locked_until = NULL, locked_by = NULL
        WHERE id IN (${placeholders(ids.length)}) AND locked_by = ? AND published_at IS NULL`,
      [...ids, instanceId],
    );
  }

  async lagSeconds(): Promise<number> {
    const rows = await this.query<{ lag: string }>(
      `SELECT coalesce(extract(epoch FROM (now() - min(occurred_at))), 0)::text AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
      [],
    );
    return Math.max(0, Number.parseFloat(rows[0]?.lag ?? '0'));
  }

  async listDueIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.query<{ id: string }>(
      `SELECT id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
        ORDER BY next_reference_attempt_at, id
        LIMIT ?`,
      [now, limit],
    );
    return rows.map((row) => row.id);
  }

  purgePublishedOutbox(cutoff: Date, batchSize: number): Promise<number> {
    return this.run(
      `DELETE FROM outbox_messages
        WHERE id IN (
          SELECT id FROM outbox_messages
           WHERE published_at < ?
           ORDER BY published_at
           LIMIT ?
             FOR UPDATE SKIP LOCKED)`,
      [cutoff, batchSize],
    );
  }

  /**
   * Sem `FOR UPDATE SKIP LOCKED`: ele exige o privilégio `UPDATE`, que o papel da aplicação
   * não tem na inbox (linhas imutáveis). O `DELETE` ordenado já basta: workers concorrentes
   * travam as linhas em comum na mesma ordem (sem deadlock) e o segundo as encontra apagadas.
   */
  purgeProcessedInbox(cutoff: Date, batchSize: number): Promise<number> {
    return this.run(
      `DELETE FROM inbox_messages
        WHERE (consumer_name, message_id) IN (
          SELECT consumer_name, message_id FROM inbox_messages
           WHERE processed_at < ?
           ORDER BY processed_at, consumer_name, message_id
           LIMIT ?)`,
      [cutoff, batchSize],
    );
  }

  private async query<T>(text: string, params: unknown[]): Promise<T[]> {
    try {
      return (await this.orm.em.fork().execute(text, params)) as T[];
    } catch (error) {
      throw mapDriverError(error);
    }
  }

  /** Statement de escrita em autocommit; devolve as linhas afetadas. */
  private async run(text: string, params: unknown[]): Promise<number> {
    try {
      const result = await this.orm.em.fork().execute<{ affectedRows: number }>(text, params, 'run');
      return result.affectedRows;
    } catch (error) {
      throw mapDriverError(error);
    }
  }
}

function toMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lockedUntil: row.locked_until ?? undefined,
    lockedBy: row.locked_by ?? undefined,
    publishedAt: row.published_at ?? undefined,
    lastError: row.last_error ?? undefined,
  });
}
