import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { HealthProbe } from '../../../application/ports/health.ts';
import { HTTP_DEPENDENCIES, type HttpDependencies } from '../http-dependencies.ts';
import type { HttpResponse } from '../http-types.ts';
import { Public } from '../guards/provider-auth.guard.ts';

const DEFAULT_READINESS_TIMEOUT_MS = 2_000; // check-money:allow

export interface ReadinessBody {
  status: 'ok' | 'unavailable';
  checks: Record<string, 'up' | 'down'>;
}

/** Endpoints operacionais: abertos por definição (§2, §9), mesmo quando houver autenticação real. */
@Public()
@Controller()
export class HealthController {
  constructor(@Inject(HTTP_DEPENDENCIES) private readonly deps: HttpDependencies) {}

  /** Processo vivo: não toca em nenhuma dependência. */
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis (cada sonda com prazo); `503` se qualquer uma falhar. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse): Promise<ReadinessBody> {
    const timeoutMs = this.deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const results = await Promise.all(this.deps.readiness.map((probe) => this.run(probe, timeoutMs)));

    const checks: Record<string, 'up' | 'down'> = {};
    for (const [name, up] of results) checks[name] = up ? 'up' : 'down';
    const healthy = results.every(([, up]) => up);
    if (!healthy) response.status(503);
    return { status: healthy ? 'ok' : 'unavailable', checks };
  }

  /** Formato de exposição Prometheus. */
  @Get('metrics')
  async metrics(@Res({ passthrough: true }) response: HttpResponse): Promise<string> {
    response.setHeader('Content-Type', this.deps.metrics.contentType);
    return this.deps.metrics.render();
  }

  private async run(probe: HealthProbe, timeoutMs: number): Promise<[string, boolean]> { // check-money:allow
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await probe.check(controller.signal);
      return [probe.name, true];
    } catch (error) {
      this.deps.logger.warn('readiness probe failed', {
        probe: probe.name,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      return [probe.name, false];
    } finally {
      clearTimeout(timer);
    }
  }
}
