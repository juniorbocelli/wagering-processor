import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs/sqs.ts';
import type { TestWallet } from './wagering-fixtures.ts';
import { sleep } from './wait.ts';

// LocalStack aceita qualquer credencial; o SDK só exige que existam.
process.env['AWS_ACCESS_KEY_ID'] ??= 'test';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'test';

export function testSqsClient(): SQSClient {
  return createSqsClient({
    AWS_ENDPOINT_URL: process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:4566',
    AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
  });
}

export interface TestQueueOptions {
  /** Visibility timeout da fila de entrada, em segundos. */
  visibilityTimeout?: number;
  /** `maxReceiveCount` da redrive policy. */
  maxReceiveCount?: number;
}

export interface TestQueues {
  client: SQSClient;
  wagerUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  cleanup(): Promise<void>;
}

/**
 * Cria filas FIFO **exclusivas do teste** no LocalStack (entrada com DLQ + redrive, e fila de
 * eventos): isolamento total entre testes sem depender de purge nem de ordem de execução.
 */
export async function createTestQueues(options: TestQueueOptions = {}): Promise<TestQueues> {
  const client = testSqsClient();
  const suffix = crypto.randomUUID().slice(0, 8);
  const fifo = { FifoQueue: 'true' };

  const dlq = await client.send(new CreateQueueCommand({ QueueName: `t-${suffix}-dlq.fifo`, Attributes: fifo }));
  const dlqArn = (
    await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl!, AttributeNames: ['QueueArn'] }))
  ).Attributes?.['QueueArn'];

  const wager = await client.send(
    new CreateQueueCommand({
      QueueName: `t-${suffix}-wager.fifo`,
      Attributes: {
        ...fifo,
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(options.visibilityTimeout ?? 30),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(options.maxReceiveCount ?? 5),
        }),
      },
    }),
  );
  const events = await client.send(new CreateQueueCommand({ QueueName: `t-${suffix}-events.fifo`, Attributes: fifo }));

  const urls = [wager.QueueUrl!, dlq.QueueUrl!, events.QueueUrl!];
  return {
    client,
    wagerUrl: wager.QueueUrl!,
    dlqUrl: dlq.QueueUrl!,
    eventsUrl: events.QueueUrl!,
    async cleanup() {
      await Promise.allSettled(urls.map((url) => client.send(new DeleteQueueCommand({ QueueUrl: url }))));
      client.destroy();
    },
  };
}

export interface WagerMessageData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface WagerMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: WagerMessageData;
}

/** Envelope `WagerTransactionRequested` (§10) para uma wallet de teste. */
export function wagerMessage(
  wallet: TestWallet,
  over: Partial<WagerMessageData> = {},
  envelope: Partial<Omit<WagerMessage, 'data'>> = {},
): WagerMessage {
  const externalTransactionId = over.externalTransactionId ?? `ext-${crypto.randomUUID()}`;
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    ...envelope,
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...over,
    },
  };
}

/** Envia o corpo à fila de entrada. `groupId` padrão = `walletId`; a deduplicação é sempre única. */
export async function sendRaw(
  queues: TestQueues,
  body: string,
  groupId: string,
  deduplicationId: string = crypto.randomUUID(),
): Promise<void> {
  await queues.client.send(
    new SendMessageCommand({
      QueueUrl: queues.wagerUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export const sendWager = (queues: TestQueues, message: WagerMessage, groupId?: string): Promise<void> =>
  sendRaw(queues, JSON.stringify(message), groupId ?? message.data.walletId);

export interface QueueDepth {
  visible: number; // check-money:allow
  inFlight: number; // check-money:allow
  delayed: number; // check-money:allow
}

export async function queueDepth(queues: TestQueues, url: string): Promise<QueueDepth> {
  const { Attributes } = await queues.client.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }),
  );
  const read = (name: string) => Number.parseInt((Attributes as Record<string, string> | undefined)?.[name] ?? '0', 10);
  return {
    visible: read('ApproximateNumberOfMessages'),
    inFlight: read('ApproximateNumberOfMessagesNotVisible'),
    delayed: read('ApproximateNumberOfMessagesDelayed'),
  };
}

export const totalDepth = async (queues: TestQueues, url: string): Promise<number> => { // check-money:allow
  const depth = await queueDepth(queues, url);
  return depth.visible + depth.inFlight + depth.delayed;
};

/** Recebe e apaga mensagens até `done(collected)` ou o prazo; devolve tudo que leu. */
export async function collect(
  queues: TestQueues,
  url: string,
  done: (messages: Message[]) => boolean,
  timeoutMs = 15_000,
): Promise<Message[]> {
  const collected: Message[] = [];
  const deadline = Date.now() + timeoutMs;
  while (!done(collected) && Date.now() < deadline) {
    const { Messages } = await queues.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    for (const message of Messages ?? []) {
      collected.push(message);
      await queues.client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
    }
    if ((Messages ?? []).length === 0) await sleep(50);
  }
  return collected;
}
