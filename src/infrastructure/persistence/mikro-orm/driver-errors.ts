import {
  ConcurrencyConflictError,
  IntegrityViolationError,
  LockTimeoutError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../../application/errors.ts';

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
}

/** Erros de rede/pool que indicam indisponibilidade, não bug: o cliente pode repetir. */
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
const TRANSIENT_MESSAGE = /timeout acquiring a connection|connection terminated|connection ended|Connection is closed|pool is draining/i;

function shapeOf(error: unknown): DriverErrorShape | undefined {
  return typeof error === 'object' && error !== null ? (error as DriverErrorShape) : undefined;
}

/**
 * Traduz erros do driver PostgreSQL (via MikroORM) para erros de aplicação tipados
 * (`23505`, `23514`/`23503`/`23000`, `40P01`/`40001`, `55P03` e falhas de conexão).
 * Qualquer outro erro passa intacto — um erro não classificado nunca vira "negócio".
 */
export function mapDriverError(error: unknown): unknown {
  const shape = shapeOf(error);
  if (shape === undefined) return error;
  const code = typeof shape.code === 'string' ? shape.code : undefined;
  const constraint = typeof shape.constraint === 'string' ? shape.constraint : undefined;
  const message = typeof shape.message === 'string' ? shape.message : '';

  switch (code) {
    case '23505':
      return new UniqueViolationError(constraint, { cause: error });
    case '23514':
    case '23503':
    case '23000':
      return new IntegrityViolationError(constraint, { cause: error, detail: message });
    case '40P01':
    case '40001':
      return new ConcurrencyConflictError({ cause: error });
    case '55P03':
      return new LockTimeoutError({ cause: error });
    case '57014': // query_canceled (statement_timeout)
    case '57P01': // admin_shutdown
    case '57P02':
    case '57P03': // cannot_connect_now
    case '53300': // too_many_connections
      return new TransientInfrastructureError('Database temporarily unavailable', { cause: error });
    default:
      break;
  }
  if (code !== undefined && (code.startsWith('08') || TRANSIENT_NODE_CODES.has(code))) {
    return new TransientInfrastructureError('Database connection failure', { cause: error });
  }
  if (TRANSIENT_MESSAGE.test(message)) {
    return new TransientInfrastructureError('Database connection failure', { cause: error });
  }
  return error;
}
