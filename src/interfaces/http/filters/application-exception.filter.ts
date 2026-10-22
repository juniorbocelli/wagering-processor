import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import {
  IdempotencyConflictError,
  ProviderIdentityMismatchError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  type Violation,
} from '../../../application/errors.ts';
import { NOOP_LOGGER, type Logger } from '../../../application/ports/observability.ts';
import type { HttpRequest, HttpResponse } from '../http-types.ts';

export const HTTP_LOGGER = Symbol('HttpLogger');

/** Corpo de erro único de todos os endpoints (ADR-007 §3). */
export interface ErrorBody {
  code: string;
  message: string;
  violations?: readonly Violation[];
  correlationId: string;
}

interface MappedError {
  status: number; // check-money:allow
  code: string;
  message: string;
  violations?: readonly Violation[];
  retryAfterSeconds?: number; // check-money:allow
}

/** Tempo sugerido em `Retry-After` para falhas transitórias (lock timeout, PG/SQS fora). */
export const TRANSIENT_RETRY_AFTER_SECONDS = 1; // check-money:allow

function clientStatusOf(error: unknown): number | undefined { // check-money:allow
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value < 500 ? value : undefined;
}

/**
 * Único ponto que traduz erros de domínio/aplicação para o mapeamento HTTP (ADR-003 §5,
 * ADR-007 §3). Um erro não classificado nunca vira 4xx: é `500`, sem detalhes.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof ValidationError) {
    return { status: 400, code: error.code, message: error.message, violations: error.violations };
  }
  if (error instanceof WalletNotFoundError) return { status: 404, code: error.code, message: error.message };
  if (error instanceof TransactionNotFoundError) return { status: 404, code: error.code, message: error.message };
  if (error instanceof ProviderIdentityMismatchError) return { status: 403, code: error.code, message: error.message };
  if (error instanceof WalletAlreadyExistsError) return { status: 409, code: error.code, message: error.message };
  if (error instanceof IdempotencyConflictError) return { status: 409, code: error.code, message: error.message };
  if (error instanceof TransientInfrastructureError) {
    return {
      status: 503,
      code: error.code,
      message: 'Temporarily unavailable; retry with the same Idempotency-Key',
      retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS,
    };
  }

  const clientStatus = error instanceof HttpException ? error.getStatus() : clientStatusOf(error);
  if (clientStatus !== undefined && clientStatus >= 400 && clientStatus < 500) {
    if (clientStatus === 404) return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
    if (clientStatus === 413) return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
    if (clientStatus === 400) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'Malformed request body', violations: [{ field: 'body', message: 'Malformed JSON' }] };
    }
    return { status: clientStatus, code: 'REQUEST_REJECTED', message: 'Request rejected' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  private readonly logger: Logger;

  constructor(@Inject(HTTP_LOGGER) logger: Logger | undefined) {
    this.logger = logger ?? NOOP_LOGGER;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const mapped = mapError(exception);
    const correlationId = request.correlationId ?? 'unknown';

    if (mapped.status >= 500) {
      const name = exception instanceof Error ? exception.name : typeof exception;
      const message = exception instanceof Error ? exception.message.slice(0, 200) : undefined;
      const fields = { correlationId, errorCode: mapped.code, errorName: name, error: message };
      // 503 é falha transitória esperada (o provedor reenvia); só o 500 é defeito nosso.
      if (mapped.status === 503) this.logger.warn('request failed transiently', fields);
      else this.logger.error('request failed unexpectedly', fields);
    }

    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    const body: ErrorBody = {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.violations === undefined ? {} : { violations: mapped.violations }),
      correlationId,
    };
    response.status(mapped.status).json(body);
  }
}
