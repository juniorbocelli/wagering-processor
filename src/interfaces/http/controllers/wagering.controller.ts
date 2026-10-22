import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ProviderIdentityMismatchError } from '../../../application/errors.ts';
import { toTransactionView, type TransactionView } from '../../../application/views.ts';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-kind.ts';
import { parseOpaqueParam, parseSubmitTransaction, parseUuidParam } from '../dto/schemas.ts';
import { HTTP_DEPENDENCIES, type HttpDependencies } from '../http-dependencies.ts';
import type { HttpRequest, HttpResponse } from '../http-types.ts';

/**
 * Mapeamento HTTP do ADR-003 §5, o mesmo em todos os endpoints de escrita:
 * `201` processada agora · `200` replay de processada · `422` rejeição de negócio (nova ou
 * replay) · `202` aguardando referência. Conflito (409), payload inválido (400) e falha
 * transitória (503) vêm do filtro de exceções.
 */
export function statusFor(status: string, replay: boolean): number { // check-money:allow
  switch (status) {
    case WagerTransactionStatus.Processed:
      return replay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      // Falha permanente de infraestrutura (ADR-007): defeito do servidor, não regra de negócio.
      return 500;
    default:
      return 202;
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(HTTP_DEPENDENCIES) private readonly deps: HttpDependencies) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TransactionView & { idempotentReplay: boolean }> {
    const command = parseSubmitTransaction(body, idempotencyKey);
    const correlationId = request.correlationId ?? this.deps.ids.next();

    const result = await this.deps.processWagerTransaction.execute(command, { correlationId });
    if (result.kind === 'duplicate-delivery') {
      // Só a entrega SQS usa a inbox; o HTTP nunca a envia.
      throw new Error('Unexpected duplicate-delivery for an HTTP request');
    }

    const replay = result.kind === 'replay';
    const view = toTransactionView(result.transaction);
    this.deps.logger.info('wager transaction handled', {
      correlationId,
      transactionId: view.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      status: view.status,
      failureCode: view.failureCode,
      idempotentReplay: replay,
    });
    response.status(statusFor(view.status, replay));
    return { ...view, idempotentReplay: replay };
  }

  @Get('wagering/transactions/:transactionId')
  async byId(
    @Param('transactionId') transactionId: string,
    @Req() request: HttpRequest,
  ): Promise<TransactionView> {
    const view = await this.deps.getTransaction.byId(parseUuidParam('transactionId', transactionId));
    const identity = request.providerIdentity;
    // Sem provedor na rota, o dono vem da própria transação (só vale com identidade verificada).
    if (identity?.authenticated === true && identity.providerId !== view.providerId) {
      throw new ProviderIdentityMismatchError();
    }
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.deps.getTransaction.byExternalId(
      parseOpaqueParam('providerId', providerId, 64),
      parseOpaqueParam('externalTransactionId', externalTransactionId, 128),
    );
  }
}
