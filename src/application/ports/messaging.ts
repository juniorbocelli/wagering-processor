import type { OutboxMessage } from '../../domain/messaging/outbox-message.ts';

// ---- entrada: fila de transações (SQS FIFO) -----------------------------------------------

export interface ReceivedMessage {
  /** `MessageId` do SQS (não o `messageId` do envelope). */
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  /** Atributo de sistema `MessageGroupId`; ausente só em filas não-FIFO. */
  groupId: string | undefined;
  /** `ApproximateReceiveCount`. */
  receiveCount: number; // check-money:allow
}

export interface ReceiveOptions {
  waitTimeSeconds: number; // check-money:allow
  maxMessages: number; // check-money:allow
  signal?: AbortSignal | undefined;
}

export interface QueueGateway {
  receive(options: ReceiveOptions): Promise<ReceivedMessage[]>;
  /** `DeleteMessage` — só depois do commit (ack). */
  delete(receiptHandle: string): Promise<void>;
  /** `ChangeMessageVisibility`; `0` devolve a mensagem à fila imediatamente. */
  changeVisibility(receiptHandle: string, seconds: number): Promise<void>; // check-money:allow
}

export interface DeadLetterMessage {
  /** Corpo original, byte a byte (pode ser justamente o que está inválido). */
  body: string;
  /** Mesmo grupo da mensagem de origem; `dlq-unparseable` se ausente (ADR-004 §3). */
  groupId: string;
  /** `MessageId` original do SQS: reenvio após crash é deduplicado na janela de 5 min. */
  deduplicationId: string;
  attributes: {
    errorCode: string;
    errorMessage: string;
    sourceMessageId: string;
    receiveCount: number; // check-money:allow
    failedAt: string;
  };
}

export interface DeadLetterPublisher {
  /** Resolve só depois de a DLQ confirmar o envio; rejeita se o envio falhar. */
  send(message: DeadLetterMessage): Promise<void>;
}

// ---- saída: outbox → fila de eventos -------------------------------------------------------

export interface EventPublisher {
  /**
   * Publica `messages` (de **uma** wallet, em ordem de `seq`, no máximo 10) na fila de
   * eventos. Devolve os `id` rejeitados individualmente; rejeita se a chamada inteira falhar.
   */
  publishBatch(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>>;
}

export interface ClaimedOutboxMessage {
  /** Posição global da outbox (`seq`); só ordena eventos da mesma wallet. */
  seq: bigint;
  message: OutboxMessage;
}

export interface ClaimOutboxInput {
  instanceId: string;
  now: Date;
  leaseMs: number; // check-money:allow
  /** Máximo de wallets (cabeças) reivindicadas por ciclo. */
  headLimit: number; // check-money:allow
  /** Máximo de eventos reservados por wallet em um ciclo. */
  perWalletLimit: number; // check-money:allow
}

/**
 * Armazenamento da outbox para os publishers (ADR-004 §4). Cada operação é uma instrução
 * curta e atômica: nenhuma conexão fica presa durante a chamada de rede ao SQS.
 */
export interface OutboxStore {
  /**
   * Reivindica a **cabeça** (evento pendente mais antigo) de cada wallet disponível e
   * reserva, com *lease*, os seguintes da mesma wallet. Devolve em ordem de `seq`.
   */
  claim(input: ClaimOutboxInput): Promise<ClaimedOutboxMessage[]>;
  /** Marca como publicados os ids ainda sob o lease de `instanceId`; devolve quantos foram marcados. */
  markPublished(ids: readonly string[], instanceId: string, at: Date): Promise<number>; // check-money:allow
  /** Persiste `attempts`/`nextAttemptAt`/`lastError` de uma mensagem já reagendada e libera o lease. */
  saveRetry(message: OutboxMessage, instanceId: string): Promise<void>;
  releaseLease(ids: readonly string[], instanceId: string): Promise<void>;
  /** Idade, em segundos, do evento pendente mais antigo (0 se não há pendentes). */
  lagSeconds(): Promise<number>; // check-money:allow
}

// ---- workers de manutenção -----------------------------------------------------------------

export interface PendingReferenceScanner {
  /** Ids de transações `PENDING_REFERENCE` com a próxima tentativa vencida, mais antigas primeiro. */
  listDueIds(now: Date, limit: number): Promise<string[]>; // check-money:allow
}

export interface RetentionStore {
  /** Apaga em lote (`SKIP LOCKED`) outbox publicada antes de `cutoff`; devolve as linhas apagadas. */
  purgePublishedOutbox(cutoff: Date, batchSize: number): Promise<number>; // check-money:allow
  /** Apaga em lote inbox processada antes de `cutoff`; devolve as linhas apagadas. */
  purgeProcessedInbox(cutoff: Date, batchSize: number): Promise<number>; // check-money:allow
}
