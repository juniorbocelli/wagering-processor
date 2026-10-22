import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { toWalletView, type LedgerPageView, type WalletView } from '../../../application/views.ts';
import type { ReconciliationReport } from '../../../application/use-cases/reconcile-wallet.ts';
import { parseCreateWallet, parseLedgerQuery, parseUuidParam } from '../dto/schemas.ts';
import { HTTP_DEPENDENCIES, type HttpDependencies } from '../http-dependencies.ts';
import type { HttpRequest } from '../http-types.ts';

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(HTTP_DEPENDENCIES) private readonly deps: HttpDependencies) {}

  /** `201` criada · `409 WALLET_ALREADY_EXISTS` · `400 VALIDATION_ERROR`. */
  @Post()
  async create(@Body() body: unknown, @Req() request: HttpRequest): Promise<WalletView> {
    const command = parseCreateWallet(body);
    const correlationId = request.correlationId ?? this.deps.ids.next();
    const wallet = await this.deps.openWallet.execute(command, { correlationId });
    this.deps.logger.info('wallet opened', { correlationId, walletId: wallet.id });
    return toWalletView(wallet);
  }

  @Get(':walletId')
  getOne(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.deps.getWallet.execute(parseUuidParam('walletId', walletId));
  }

  /** Cursor opaco e estável (keyset por `wallet_version`); `limit` de 1 a 200 (padrão 50). */
  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: Record<string, unknown>): Promise<LedgerPageView> {
    const { cursor, limit } = parseLedgerQuery(query);
    return this.deps.listLedger.execute(parseUuidParam('walletId', walletId), { cursor, limit });
  }

  /** Divergências são sinalizadas (`consistent: false`), logadas e contadas — nunca corrigidas. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string, @Req() request: HttpRequest): Promise<ReconciliationReport> {
    const id = parseUuidParam('walletId', walletId);
    const report = await this.deps.reconcileWallet.execute(id);
    this.deps.logger.info('wallet reconciliation requested', {
      correlationId: request.correlationId,
      walletId: id,
      consistent: report.consistent,
    });
    return report;
  }
}
