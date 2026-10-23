import type { Subprocess } from 'bun';
import type { TestQueues } from './sqs.ts';
import { TEST_URLS } from './db.ts';
import { waitFor } from './wait.ts';

/**
 * Harness multi-processo dos testes de concorrência (§13): sobe N cópias reais da aplicação
 * (`bun src/main.ts`, a mesma entrada da imagem Docker) em portas distintas, todas sobre o
 * mesmo PostgreSQL e o mesmo LocalStack. Nenhum componente é substituído por mock.
 */

const ROOT = `${import.meta.dir}/../..`;

/** Porta livre atribuída pelo SO (abre e fecha um listener efêmero). */
async function freePort(): Promise<number> { // check-money:allow
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

export type FaultPointName = 'crash_after_commit_before_ack' | 'crash_after_publish_before_mark';

export interface InstanceOptions {
  queues: TestQueues;
  /** Ponto de falha que mata o processo com `SIGKILL` (somente nesta instância). */
  fault?: FaultPointName;
  /** Variáveis extras de ambiente (sobrepõem os padrões do harness). */
  env?: Record<string, string>;
}

function queueName(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

export class ServiceInstance {
  private logBuffer = '';

  private constructor(
    readonly port: number, // check-money:allow
    private readonly proc: Subprocess<'ignore', 'pipe', 'pipe'>,
  ) {}

  static async spawn(options: InstanceOptions): Promise<ServiceInstance> {
    const port = await freePort();
    const { queues, fault, env = {} } = options;
    const inherited = { ...process.env };
    delete inherited['FAULT_INJECTION'];

    const proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: ROOT,
      env: {
        ...inherited,
        DATABASE_URL: TEST_URLS.app,
        PORT: String(port),
        DB_POOL_MAX: '15',
        AWS_ENDPOINT_URL: process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566',
        AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        WAGER_QUEUE_NAME: queueName(queues.wagerUrl),
        WAGER_DLQ_NAME: queueName(queues.dlqUrl),
        EVENTS_QUEUE_NAME: queueName(queues.eventsUrl),
        // Ciclos curtos: a recuperação após crash precisa caber no tempo de um teste.
        OUTBOX_POLL_INTERVAL_MS: '100',
        OUTBOX_LEASE_MS: '3000',
        PENDING_REFERENCE_POLL_INTERVAL_MS: '300',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
        SHUTDOWN_GRACE_MS: '3000',
        LOG_LEVEL: 'warn',
        ...(fault === undefined ? {} : { FAULT_INJECTION: fault }),
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const instance = new ServiceInstance(port, proc);
    // Os pipes precisam ser drenados, senão o processo bloqueia ao encher o buffer do SO.
    void instance.drain(proc.stdout);
    void instance.drain(proc.stderr);
    return instance;
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.logBuffer = (this.logBuffer + decoder.decode(chunk)).slice(-20_000);
      }
    } catch {
      // processo encerrado: nada a drenar
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get logs(): string {
    return this.logBuffer;
  }

  get exited(): Promise<number> {
    return this.proc.exited;
  }

  get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  get signalCode(): string | null {
    const { signalCode } = this.proc;
    return signalCode === null ? null : String(signalCode);
  }

  async isReady(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/health/ready`, { signal: AbortSignal.timeout(2_000) })).status === 200;
    } catch {
      return false;
    }
  }

  async waitReady(timeoutMs = 45_000): Promise<void> {
    await waitFor(
      async () => {
        if (!this.alive) throw new Error(`instance on port ${this.port} died while booting:\n${this.logBuffer}`);
        return this.isReady();
      },
      { timeoutMs, intervalMs: 150, message: `instance on port ${this.port} to be ready` },
    );
  }

  /** `SIGKILL` = morte abrupta (sem handlers, sem ack, sem liberar lease). `SIGTERM` = gracioso. */
  async kill(signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL'): Promise<void> {
    if (this.alive) this.proc.kill(signal);
    await this.proc.exited;
  }
}

/** Conjunto de instâncias com *round-robin* determinístico de requisições. */
export class Cluster {
  private cursor = 0; // check-money:allow

  private constructor(
    readonly instances: ServiceInstance[],
    private readonly options: InstanceOptions,
  ) {}

  static async start(size: number, options: InstanceOptions): Promise<Cluster> { // check-money:allow
    const instances = await Promise.all(Array.from({ length: size }, () => ServiceInstance.spawn(options)));
    const cluster = new Cluster(instances, options);
    try {
      await Promise.all(instances.map((instance) => instance.waitReady()));
    } catch (error) {
      await cluster.stop();
      throw error;
    }
    return cluster;
  }

  /** Próxima instância viva, em rodízio. */
  next(): ServiceInstance {
    for (let attempts = 0; attempts < this.instances.length; attempts += 1) {
      const instance = this.instances[this.cursor % this.instances.length]!;
      this.cursor += 1;
      if (instance.alive) return instance;
    }
    throw new Error('no live instance in the cluster');
  }

  at(index: number): ServiceInstance { // check-money:allow
    return this.instances[index % this.instances.length]!;
  }

  /** Mata todas as instâncias de uma vez (queda total do serviço). */
  async killAll(signal: 'SIGKILL' | 'SIGTERM' = 'SIGKILL'): Promise<void> {
    await Promise.all(this.instances.map((instance) => instance.kill(signal)));
  }

  /** Substitui as instâncias por novas (mesmas filas e banco) e espera ficarem prontas. */
  async restartAll(): Promise<void> {
    const { fault: _fault, ...healthy } = this.options;
    const fresh = await Promise.all(this.instances.map(() => ServiceInstance.spawn(healthy)));
    await Promise.all(fresh.map((instance) => instance.waitReady()));
    this.instances.splice(0, this.instances.length, ...fresh);
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.instances.map((instance) => instance.kill('SIGTERM')));
  }
}

// ---- cliente HTTP do cluster (sem estado; cada chamada escolhe a instância)

export interface HttpResult {
  status: number; // check-money:allow
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function call(
  instance: ServiceInstance,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const execute = async (): Promise<HttpResult> => {
    const response = await fetch(`${instance.url}${path}`, {
      method,
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  };

  try {
    return await execute();
  } catch (error) {
    if ((error as { code?: string })?.code === 'ECONNRESET') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return await execute();
    }
    throw error;
  }
}

/** Largada sincronizada: todas as tarefas só disparam depois de a barreira abrir. */
export function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
