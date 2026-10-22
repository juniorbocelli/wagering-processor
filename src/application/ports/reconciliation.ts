/**
 * Leitura de um snapshot consistente de uma wallet e do seu ledger (ADR-012). Todos os
 * valores monetários chegam como string `NUMERIC(19,2)`; a aplicação os reidrata em `Money`.
 */
export interface WalletLedgerAudit {
  walletId: string;
  currency: string;
  /** `wallets.balance_amount`. */
  storedBalance: string;
  /** `wallets.version`. */
  version: number; // check-money:allow
  /** `Σ CREDIT − Σ DEBIT` calculado pelo banco em `NUMERIC`. */
  calculatedBalance: string;
  entries: number; // check-money:allow
  /** Maior `wallet_version` do ledger; `null` com ledger vazio. */
  lastWalletVersion: number | null; // check-money:allow
  /** Lançamentos cuja corrente (`balance_before` = `balance_after` anterior) está quebrada. */
  brokenLinks: number; // check-money:allow
}

export interface SweepResult {
  /** `false` quando outra instância já varre (advisory lock) e esta rodada foi pulada. */
  ran: boolean;
  checked: number; // check-money:allow
}

export interface ReconciliationStore {
  /** Auditoria de uma wallet em transação `REPEATABLE READ READ ONLY`; `null` se não existe. */
  audit(walletId: string): Promise<WalletLedgerAudit | null>;
  /**
   * Varre **todas** as wallets em lotes por keyset, numa única transação `REPEATABLE READ
   * READ ONLY` protegida por advisory lock: uma instância por vez no cluster.
   */
  sweep(batchSize: number, visit: (batch: readonly WalletLedgerAudit[]) => void): Promise<SweepResult>; // check-money:allow
}
