import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  ReconciliationStore,
  SweepResult,
  WalletLedgerAudit,
} from '../../../application/ports/reconciliation.ts';
import { mapDriverError } from './driver-errors.ts';

/** Chave do advisory lock da varredura periódica (ADR-012): uma instância por vez no cluster. */
export const RECONCILIATION_ADVISORY_LOCK_KEY = 7_040_012;

const FIRST_UUID = '00000000-0000-0000-0000-000000000000';

interface AuditRow {
  wallet_id: string;
  currency: string;
  stored: string;
  version: number;
  calculated: string;
  entries: string;
  last_version: number | null;
  broken: string;
}

/**
 * Cálculo em SQL `NUMERIC` (nunca em ponto flutuante): `Σ CREDIT − Σ DEBIT`, continuidade da
 * corrente por janela (`balance_before = LAG(balance_after)`, `wallet_version` sem buracos;
 * o primeiro lançamento parte de 0 e tem versão 1 ou 2 — ADR-002) e última versão.
 */
const AUDIT_SELECT = `
  SELECT w.id AS wallet_id, w.currency::text AS currency, w.balance_amount::text AS stored, w.version,
         coalesce(l.calculated, 0)::numeric(19,2)::text AS calculated,
         coalesce(l.entries, 0)::text AS entries, l.last_version,
         coalesce(l.broken, 0)::text AS broken
    FROM wallets w
    LEFT JOIN LATERAL (
      SELECT sum(CASE c.direction WHEN 'CREDIT' THEN c.amount ELSE -c.amount END) AS calculated,
             count(*) AS entries,
             max(c.wallet_version) AS last_version,
             count(*) FILTER (WHERE NOT c.link_ok) AS broken
        FROM (
          SELECT e.direction, e.amount, e.wallet_version,
                 CASE WHEN lag(e.wallet_version) OVER o IS NULL
                      THEN e.balance_before = 0 AND e.wallet_version IN (1, 2)
                      ELSE e.balance_before = lag(e.balance_after) OVER o
                       AND e.wallet_version = lag(e.wallet_version) OVER o + 1
                 END AS link_ok
            FROM wallet_ledger_entries e
           WHERE e.wallet_id = w.id
          WINDOW o AS (ORDER BY e.wallet_version)
        ) c
    ) l ON true`;

function toAudit(row: AuditRow): WalletLedgerAudit {
  return {
    walletId: row.wallet_id,
    currency: row.currency,
    storedBalance: row.stored,
    version: row.version,
    calculatedBalance: row.calculated,
    entries: Number.parseInt(row.entries, 10),
    lastWalletVersion: row.last_version,
    brokenLinks: Number.parseInt(row.broken, 10),
  };
}

/**
 * Auditoria somente leitura (ADR-012). Cada auditoria roda em transação
 * `REPEATABLE READ READ ONLY`: saldo e ledger da wallet vêm do mesmo snapshot e nenhum
 * escritor é bloqueado (MVCC).
 */
export class MikroOrmReconciliationStore implements ReconciliationStore {
  constructor(private readonly orm: MikroORM) {}

  async audit(walletId: string): Promise<WalletLedgerAudit | null> {
    const rows = await this.snapshot((em) => em.execute<AuditRow[]>(`${AUDIT_SELECT} WHERE w.id = ?`, [walletId]));
    const [row] = rows;
    return row === undefined ? null : toAudit(row);
  }

  async sweep(batchSize: number, visit: (batch: readonly WalletLedgerAudit[]) => void): Promise<SweepResult> { // check-money:allow
    // A transação externa (READ COMMITTED, sem snapshot entre comandos) só segura o advisory
    // lock. Cada lote é auditado em um snapshot REPEATABLE READ próprio e curto: a auditoria é
    // por wallet (saldo e ledger do mesmo snapshot), então não precisa de snapshot global, e
    // assim o xmin horizon avança e o autovacuum não fica bloqueado durante a varredura.
    try {
      return await this.orm.em.fork().transactional(async (lockEm) => {
        const [lock] = await lockEm.execute<{ locked: boolean }[]>('SELECT pg_try_advisory_xact_lock(?) AS locked', [
          RECONCILIATION_ADVISORY_LOCK_KEY,
        ]);
        if (lock?.locked !== true) return { ran: false, checked: 0 };

        let checked = 0; // check-money:allow
        let lastId = FIRST_UUID;
        for (;;) {
          const rows = await this.snapshot((em) =>
            em.execute<AuditRow[]>(`${AUDIT_SELECT} WHERE w.id > ? ORDER BY w.id LIMIT ?`, [lastId, batchSize]),
          );
          if (rows.length === 0) break;
          visit(rows.map(toAudit));
          checked += rows.length;
          lastId = rows[rows.length - 1]!.wallet_id;
          if (rows.length < batchSize) break;
        }
        return { ran: true, checked };
      });
    } catch (error) {
      throw mapDriverError(error);
    }
  }

  private async snapshot<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(work, {
        isolationLevel: IsolationLevel.REPEATABLE_READ,
        readOnly: true,
      });
    } catch (error) {
      throw mapDriverError(error);
    }
  }
}
