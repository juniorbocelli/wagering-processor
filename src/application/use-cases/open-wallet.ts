import { UniqueViolationError, ValidationError, WalletAlreadyExistsError } from '../errors.ts';
import type {
  LedgerRepository,
  OutboxRepository,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/persistence.ts';
import type { Clock, IdGenerator, PayloadHasher } from '../ports/runtime.ts';
import { DomainError } from '../../domain/shared/domain-error.ts';
import { Money, type MoneyProps } from '../../domain/money/money.ts';
import { Wallet } from '../../domain/wallet/wallet.ts';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
} from '../../domain/wagering/wager-transaction.ts';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.ts';
import { OutboxMessage } from '../../domain/messaging/outbox-message.ts';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wager-events.ts';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletDependencies {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  hasher: PayloadHasher;
  clock: Clock;
  ids: IdGenerator;
}

const UQ_WALLET_PLAYER_CURRENCY = 'uq_wallets_player_currency';

/**
 * Abre uma wallet (`version = 1`). **Somente se `initialBalance > 0`**, na mesma transação
 * SQL: transação `OPENING` (provider `internal`, key `opening:{walletId}`), lançamento
 * `CREDIT` com `wallet_version = 1` e `WalletBalanceChanged` na outbox. Com saldo zero não
 * há lançamento nem evento. `23505` em `uq_wallets_player_currency` → conflito (409).
 */
export class OpenWalletUseCase {
  constructor(private readonly deps: OpenWalletDependencies) {}

  async execute(command: OpenWalletCommand, ctx: { correlationId: string }): Promise<Wallet> {
    const initialBalance = this.validate(command);
    const walletId = this.deps.ids.next();
    const at = this.deps.clock.now();
    const opening = { transactionId: this.deps.ids.next(), entryId: this.deps.ids.next() };

    let opened: ReturnType<typeof Wallet.open>;
    try {
      opened = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance,
        at,
        opening,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw new ValidationError([{ field: 'body', message: error.message }]);
      }
      throw error;
    }
    const { wallet, openingEntry } = opened;

    try {
      await this.deps.uow.run(async () => {
        await this.deps.wallets.add(wallet);
        if (openingEntry === undefined) return;

        const openingKey = `opening:${walletId}`;
        const { hash } = this.deps.hasher.hash({
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: openingKey,
          playerId: wallet.playerId,
          walletId,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: initialBalance.toJSON(),
        });
        const transaction = WagerTransaction.createOpening({
          id: opening.transactionId,
          walletId,
          playerId: wallet.playerId,
          money: initialBalance,
          payloadHash: hash,
          correlationId: ctx.correlationId,
          createdAt: at,
        });
        transaction.markProcessed(undefined, at, wallet.balance);
        await this.deps.transactions.add(transaction);
        await this.deps.ledger.add(openingEntry);
        await this.deps.outbox.add(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, {
              eventId: this.deps.ids.next(),
              correlationId: ctx.correlationId,
              occurredAt: at,
            }),
          ),
        );
        await this.deps.outbox.add(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(transaction, wallet, {
              eventId: this.deps.ids.next(),
              correlationId: ctx.correlationId,
              occurredAt: at,
            }),
          ),
        );
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === UQ_WALLET_PLAYER_CURRENCY) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
    return wallet;
  }

  private validate(command: OpenWalletCommand): Money {
    try {
      return Money.from(command.initialBalance);
    } catch (error) {
      throw new ValidationError([
        { field: 'initialBalance', message: error instanceof Error ? error.message : 'Invalid money' },
      ]);
    }
  }
}
