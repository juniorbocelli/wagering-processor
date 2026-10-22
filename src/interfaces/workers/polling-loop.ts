import { SimulatedCrashError } from '../../application/ports/runtime.ts';
import type { Logger } from '../../application/ports/observability.ts';

export interface PollingLoopOptions {
  name: string;
  /** Espera entre ciclos quando não há trabalho (com trabalho, o próximo ciclo é imediato). */
  intervalMs: number;
  /** Um ciclo de trabalho; `true` se pode haver mais trabalho imediato. */
  tick: () => Promise<boolean>;
  logger: Logger;
}

/**
 * Laço de polling de um worker. Exceções do ciclo são logadas e o laço continua (um erro
 * transitório de banco/SQS não derruba o worker); só `SimulatedCrashError` — o substituto
 * em-processo de `SIGKILL` — interrompe o laço sem qualquer limpeza.
 */
export class PollingLoop {
  private running = false;
  private done: Promise<void> = Promise.resolve();
  private wakeUp: (() => void) | undefined;
  private crashedWith: SimulatedCrashError | undefined;

  constructor(private readonly options: PollingLoopOptions) {}

  get crashed(): boolean {
    return this.crashedWith !== undefined;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.crashedWith = undefined;
    this.done = this.run();
  }

  /** Para de iniciar ciclos e aguarda o ciclo corrente terminar. */
  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.done;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let more = false;
      try {
        more = await this.options.tick();
      } catch (error) {
        if (error instanceof SimulatedCrashError) {
          this.crashedWith = error;
          this.running = false;
          this.options.logger.warn('worker halted by simulated crash', { worker: this.options.name, point: error.point });
          return;
        }
        this.options.logger.error('worker cycle failed', {
          worker: this.options.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.running && !more) await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.options.intervalMs);
      this.wakeUp = finish;
    });
  }
}
