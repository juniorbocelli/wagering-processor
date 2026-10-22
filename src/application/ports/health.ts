/** Sonda de dependência para `GET /health/ready`. Rejeita se a dependência estiver inalcançável. */
export interface HealthProbe {
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}
