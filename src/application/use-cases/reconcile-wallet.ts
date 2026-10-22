import { WalletNotFoundError } from '../errors.ts';
import { NOOP_LOGGER, NOOP_METRICS, type Logger, type Metrics } from '../ports/observability.ts';
import type { ReconciliationStore, WalletLedgerAudit } from '../ports/reconciliation.ts';
import { Money, type MoneyProps } from '../../domain/money/money.ts';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** `stored − calculated`: zero quando consistente; pode ser negativa. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number; // check-money:allow
  /** Cada lançamento parte do saldo final do anterior, sem buracos de `wallet_version`. */
  chainIntact: boolean;
  /** `wallet.version = último wallet_version`; sem lançamentos, só vale versão 1 com saldo zero. */
  versionConsistent: boolean;
}

/** Avalia uma auditoria: aritmética sempre em `Money` (bigint), nunca em `number`. */
export function evaluateAudit(audit: WalletLedgerAudit): ReconciliationReport {
  const stored = Money.rehydrate({ amount: audit.storedBalance, currency: audit.currency });
  const calculated = Money.rehydrate({ amount: audit.calculatedBalance, currency: audit.currency });
  const difference = stored.subtract(calculated);
  const chainIntact = audit.brokenLinks === 0;
  // Sem lançamentos só é coerente uma wallet virgem (versão 1, saldo zero): saldo inicial
  // positivo sempre gera o lançamento OPENING, então ledger vazio + saldo ≠ 0 é perda de ledger.
  const versionConsistent =
    audit.lastWalletVersion === null
      ? audit.version === 1 && stored.isZero()
      : audit.version === audit.lastWalletVersion;
  return {
    walletId: audit.walletId,
    storedBalance: stored.toJSON(),
    calculatedBalance: calculated.toJSON(),
    difference: difference.toJSON(),
    consistent: difference.isZero() && chainIntact && versionConsistent,
    checkedEntries: audit.entries,
    chainIntact,
    versionConsistent,
  };
}

export interface ReconcileDependencies {
  store: ReconciliationStore;
  metrics?: Metrics;
  logger?: Logger;
}

function reportDivergence(report: ReconciliationReport, deps: Required<Pick<ReconcileDependencies, 'metrics' | 'logger'>>): void {
  deps.metrics.reconciliationDivergence();
  // Divergências são sinalizadas, nunca corrigidas (ADR-012): decisão humana via ajuste auditável.
  deps.logger.error('wallet reconciliation divergence detected', {
    walletId: report.walletId,
    difference: report.difference.amount,
    chainIntact: report.chainIntact,
    versionConsistent: report.versionConsistent,
  });
}

/** `POST /wallets/:walletId/reconciliation`: snapshot consistente, detecta e não corrige. */
export class ReconcileWalletUseCase {
  private readonly metrics: Metrics;
  private readonly logger: Logger;

  constructor(private readonly deps: ReconcileDependencies) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  async execute(walletId: string): Promise<ReconciliationReport> {
    const audit = await this.deps.store.audit(walletId);
    if (audit === null) throw new WalletNotFoundError(walletId);
    const report = evaluateAudit(audit);
    if (!report.consistent) reportDivergence(report, { metrics: this.metrics, logger: this.logger });
    return report;
  }
}

export interface SweepSummary {
  ran: boolean;
  checked: number; // check-money:allow
  divergentWalletIds: string[];
}

/** Varredura periódica de todas as wallets (ADR-012). */
export class ReconcileAllWalletsUseCase {
  private readonly metrics: Metrics;
  private readonly logger: Logger;

  constructor(
    private readonly deps: ReconcileDependencies & { clock: { now(): Date }; batchSize?: number }, // check-money:allow
  ) {
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  async execute(): Promise<SweepSummary> {
    const divergentWalletIds: string[] = [];
    const result = await this.deps.store.sweep(this.deps.batchSize ?? 500, (batch) => { // check-money:allow
      for (const audit of batch) {
        const report = evaluateAudit(audit);
        if (report.consistent) continue;
        divergentWalletIds.push(report.walletId);
        reportDivergence(report, { metrics: this.metrics, logger: this.logger });
      }
    });
    if (!result.ran) return { ran: false, checked: 0, divergentWalletIds };

    this.metrics.reconciliationSweepCompleted(divergentWalletIds.length, this.deps.clock.now());
    this.logger.info('wallet reconciliation sweep completed', {
      checkedWallets: result.checked,
      divergentWallets: divergentWalletIds.length,
    });
    return { ran: true, checked: result.checked, divergentWalletIds };
  }
}
