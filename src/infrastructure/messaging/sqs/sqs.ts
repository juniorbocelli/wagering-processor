import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  DeadLetterMessage,
  DeadLetterPublisher,
  EventPublisher,
  QueueGateway,
  ReceivedMessage,
  ReceiveOptions,
} from '../../../application/ports/messaging.ts';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.ts';

/** Cliente SQS a partir do ambiente (`AWS_ENDPOINT_URL` aponta para o LocalStack em dev). */
export function createSqsClient(env: Record<string, string | undefined> = process.env): SQSClient {
  const endpoint = env['AWS_ENDPOINT_URL'];
  return new SQSClient({
    region: env['AWS_REGION'] ?? 'us-east-1',
    ...(endpoint === undefined ? {} : { endpoint }),
  });
}

export async function resolveQueueUrl(client: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (QueueUrl === undefined) throw new Error(`SQS queue "${queueName}" has no URL`);
  return QueueUrl;
}

/** Fila de entrada (`wager-transactions.fifo`) sobre o SDK v3. */
export class SqsQueue implements QueueGateway {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async receive(options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const { Messages } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
      }),
      options.signal === undefined ? undefined : { abortSignal: options.signal },
    );
    return (Messages ?? []).flatMap((message) => {
      if (message.MessageId === undefined || message.ReceiptHandle === undefined) return [];
      return [
        {
          sqsMessageId: message.MessageId,
          receiptHandle: message.ReceiptHandle,
          body: message.Body ?? '',
          groupId: message.Attributes?.['MessageGroupId'],
          receiveCount: Number.parseInt(message.Attributes?.['ApproximateReceiveCount'] ?? '1', 10),
        },
      ];
    });
  }

  async delete(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

/** Envio explícito à DLQ FIFO (ADR-004 §3): grupo e deduplicação independentes do corpo. */
export class SqsDeadLetterPublisher implements DeadLetterPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: DeadLetterMessage): Promise<void> {
    const text = (value: string) => ({ DataType: 'String', StringValue: value });
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.deduplicationId,
        MessageAttributes: {
          errorCode: text(message.attributes.errorCode),
          errorMessage: text(message.attributes.errorMessage),
          sourceMessageId: text(message.attributes.sourceMessageId),
          receiveCount: { DataType: 'Number', StringValue: String(message.attributes.receiveCount) },
          failedAt: text(message.attributes.failedAt),
        },
      }),
    );
  }
}

/**
 * Publica eventos da outbox em `wallet-events.fifo`: `MessageGroupId = aggregateId` (ordem
 * por wallet) e `MessageDeduplicationId = eventId` (republicação dentro da janela de 5 min
 * é descartada pelo próprio SQS; fora dela o consumidor deduplica por `eventId`).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishBatch(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    const { Failed } = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: messages.map((message) => ({
          Id: message.id,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: message.eventType },
          },
        })),
      }),
    );
    return new Set((Failed ?? []).flatMap((failure) => (failure.Id === undefined ? [] : [failure.Id])));
  }
}
