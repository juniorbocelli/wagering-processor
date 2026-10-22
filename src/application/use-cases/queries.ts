import { TransactionNotFoundError, ValidationError, WalletNotFoundError } from '../errors.ts';
import type { LedgerRepository, WagerTransactionRepository, WalletRepository } from '../ports/persistence.ts';
import {
  toLedgerEntryView,
  toTransactionView,
  toWalletView,
  type LedgerPageView,
  type TransactionView,
  type WalletView,
} from '../views.ts';

export const DEFAULT_LEDGER_PAGE_SIZE = 50; // check-money:allow
export const MAX_LEDGER_PAGE_SIZE = 200; // check-money:allow

/** Cursor opaco: `base64url({"v": <wallet_version do último item>})`. */
export function encodeLedgerCursor(walletVersion: number): string { // check-money:allow
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number { // check-money:allow
  const invalid = () => new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }]);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const version = (parsed as { v?: unknown } | null)?.v;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw invalid();
  return version;
}

export class GetWalletUseCase {
  constructor(private readonly deps: { wallets: WalletRepository }) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.deps.wallets.findById(walletId);
    if (wallet === null) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }
}

export class ListLedgerUseCase {
  constructor(private readonly deps: { wallets: WalletRepository; ledger: LedgerRepository }) {}

  async execute(walletId: string, options: { cursor?: string | undefined; limit?: number | undefined }): Promise<LedgerPageView> { // check-money:allow
    const limit = options.limit ?? DEFAULT_LEDGER_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE_SIZE) {
      throw new ValidationError([{ field: 'limit', message: `must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}` }]);
    }
    const after = options.cursor === undefined ? 0 : decodeLedgerCursor(options.cursor);
    if ((await this.deps.wallets.findById(walletId)) === null) throw new WalletNotFoundError(walletId);

    // limit + 1: a linha extra diz se há próxima página sem uma consulta de contagem.
    const entries = await this.deps.ledger.listPage(walletId, after, limit + 1);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toLedgerEntryView),
      nextCursor: entries.length > limit && last !== undefined ? encodeLedgerCursor(last.walletVersion) : null,
    };
  }
}

export class GetTransactionUseCase {
  constructor(private readonly deps: { transactions: WagerTransactionRepository }) {}

  async byId(transactionId: string): Promise<TransactionView> {
    const transaction = await this.deps.transactions.findById(transactionId);
    if (transaction === null) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(transaction);
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const transaction = await this.deps.transactions.findByExternalId(providerId, externalTransactionId);
    if (transaction === null) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toTransactionView(transaction);
  }
}
