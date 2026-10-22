import pino from 'pino';
import type { Logger, LogFields } from '../../application/ports/observability.ts';

/** Adapter pino → porta `Logger`. Saída JSON em uma linha por evento (§12). */
class PinoLogger implements Logger {
  constructor(private readonly base: pino.Logger) {}

  debug(message: string, fields?: LogFields): void {
    this.base.debug(fields ?? {}, message);
  }
  info(message: string, fields?: LogFields): void {
    this.base.info(fields ?? {}, message);
  }
  warn(message: string, fields?: LogFields): void {
    this.base.warn(fields ?? {}, message);
  }
  error(message: string, fields?: LogFields): void {
    this.base.error(fields ?? {}, message);
  }
  child(fields: LogFields): Logger {
    return new PinoLogger(this.base.child({ ...fields }));
  }
}

export interface LoggerOptions {
  level?: string;
  /** Destino do log; padrão `stdout`. Usado por testes para capturar a saída. */
  destination?: pino.DestinationStream;
}

/**
 * Logger raiz. A aplicação só loga identificadores (`correlationId`, `messageId`,
 * `transactionId`, `walletId`, `providerId`); `redact` é uma segunda barreira contra
 * vazamento de payload financeiro caso algum campo escape.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const config: pino.LoggerOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: ['money', '*.money', 'amount', '*.amount', 'payload', 'body'], censor: '[redacted]' },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return new PinoLogger(options.destination === undefined ? pino(config) : pino(config, options.destination));
}
