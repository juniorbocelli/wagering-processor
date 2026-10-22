import type { FaultInjector, FaultPoint } from '../application/ports/runtime.ts';
import { NOOP_FAULT_INJECTOR } from '../application/ports/runtime.ts';

const CRASH_POINTS: readonly FaultPoint[] = ['crash_after_commit_before_ack', 'crash_after_publish_before_mark'];

/**
 * Injetor ativado por ambiente (`FAULT_INJECTION=<ponto>`), para testes multi-processo:
 * ao atingir o ponto, o processo é encerrado com `SIGKILL` — sem handlers, sem ack, sem
 * liberar lease. Sem a variável, é o no-op de produção.
 */
export class EnvFaultInjector implements FaultInjector {
  constructor(
    private readonly point: FaultPoint,
    private readonly kill: () => void = () => {
      process.kill(process.pid, 'SIGKILL');
    },
  ) {}

  trigger(point: FaultPoint): void {
    if (point === this.point) this.kill();
  }
}

export function faultInjectorFromEnv(env: Record<string, string | undefined> = process.env): FaultInjector {
  const configured = env['FAULT_INJECTION'];
  if (configured === undefined || configured === '') return NOOP_FAULT_INJECTOR;
  if (!(CRASH_POINTS as readonly string[]).includes(configured)) {
    throw new Error(`Unknown FAULT_INJECTION point "${configured}" (expected one of: ${CRASH_POINTS.join(', ')})`);
  }
  return new EnvFaultInjector(configured as FaultPoint);
}
