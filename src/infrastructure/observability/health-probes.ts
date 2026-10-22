import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { HealthProbe } from '../../application/ports/health.ts';

/** PostgreSQL alcançável: `SELECT 1` numa conexão do pool. */
export class PostgresHealthProbe implements HealthProbe {
  readonly name = 'postgres';

  constructor(private readonly orm: MikroORM) {}

  async check(signal: AbortSignal): Promise<void> {
    await raceWithAbort(this.orm.em.fork().execute('SELECT 1'), signal);
  }
}

/** SQS alcançável: `GetQueueAttributes` da fila de entrada (a URL é resolvida e guardada). */
export class SqsHealthProbe implements HealthProbe {
  readonly name = 'sqs';
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    if (this.queueUrl === undefined) {
      const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
        abortSignal: signal,
      });
      if (QueueUrl === undefined) throw new Error(`SQS queue "${this.queueName}" has no URL`);
      this.queueUrl = QueueUrl;
    }
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }),
      { abortSignal: signal },
    );
  }
}

/** Rejeita assim que o sinal abortar, mesmo que a chamada subjacente (sem suporte a abort) fique pendurada. */
function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('health probe timed out'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
