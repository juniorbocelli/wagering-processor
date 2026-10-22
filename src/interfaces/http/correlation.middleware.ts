import type { IdGenerator } from '../../application/ports/runtime.ts';
import { NOOP_LOGGER, type Logger } from '../../application/ports/observability.ts';
import { CORRELATION_HEADER, type HttpRequest, type HttpResponse } from './http-types.ts';

/** IDs de correlação aceitos do cliente: curtos e sem caracteres de controle/injeção em log. */
const ACCEPTED_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelationOptions {
  ids: IdGenerator;
  logger?: Logger;
}

/**
 * Middleware de correlação e log de acesso. Usa `X-Correlation-Id` quando válido; senão gera
 * um UUIDv7. O mesmo id volta no header da resposta, no corpo dos erros e nos logs. O log de
 * acesso registra só metadados (método, caminho sem query, status, duração): nunca o corpo.
 */
export function correlationMiddleware(options: CorrelationOptions) {
  const logger = options.logger ?? NOOP_LOGGER;
  return (request: HttpRequest, response: HttpResponse, next: () => void): void => {
    const supplied = request.headers[CORRELATION_HEADER];
    const correlationId =
      typeof supplied === 'string' && ACCEPTED_CORRELATION_ID.test(supplied) ? supplied : options.ids.next();
    request.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);

    const startedAt = performance.now();
    response.on('finish', () => {
      logger.info('http request completed', {
        correlationId,
        method: request.method,
        path: (request.originalUrl ?? request.url ?? '').split('?')[0],
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    next();
  };
}
