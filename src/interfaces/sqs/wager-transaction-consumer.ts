import { z } from 'zod';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  ValidationError,
  WalletNotFoundError,
} from '../../application/errors.ts';
import type {
  DeadLetterPublisher,
  QueueGateway,
  ReceivedMessage,
} from '../../application/ports/messaging.ts';
import { NOOP_LOGGER, NOOP_METRICS, type Logger, type Metrics } from '../../application/ports/observability.ts';
import {
  NOOP_FAULT_INJECTOR,
  SimulatedCrashError,
  type FaultInjector,
} from '../../application/ports/runtime.ts';
import type {
  ProcessContext,
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '../../application/use-cases/process-wager-transaction.ts';

/** Nome do consumidor na chave da inbox `(consumerName, messageId)`. */
export const WAGER_CONSUMER_NAME = 'wager-transactions';

/** Grupo usado na DLQ quando a mensagem de origem não traz `MessageGroupId`. */
export const UNPARSEABLE_DLQ_GROUP = 'dlq-unparseable';

// ---- envelope (§10) -----------------------------------------------------------------------

const moneySchema = z.strictObject({ amount: z.string(), currency: z.string() });

const dataSchema = z.strictObject({
  providerId: z.string(),
  externalTransactionId: z.string(),
  idempotencyKey: z.string(),
  playerId: z.string(),
  walletId: z.string(),
  roundId: z.string(),
  gameId: z.string(),
  kind: z.string(),
  money: moneySchema,
  referenceExternalTransactionId: z.string().nullish(),
});

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(128),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: dataSchema,
});

export interface ParsedEnvelope {
  messageId: string;
  command: ProcessWagerTransactionCommand;
}

export type ParseResult = { ok: true; value: ParsedEnvelope } | { ok: false; reason: string };

/**
 * Valida o corpo SQS. `amount` precisa ser string (um `number` JSON é rejeitado aqui, antes
 * de virar dinheiro); campos desconhecidos em `data` também. A validação de domínio
 * (UUID da wallet, `kind`, valor) continua sendo do caso de uso — o mesmo do HTTP.
 */
export function parseEnvelope(body: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'Message body is not valid JSON' };
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason };
  }
  const { messageId, data } = parsed.data;
  return {
    ok: true,
    value: {
      messageId,
      command: {
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
      },
    },
  };
}

// ---- classificação de erros (ADR-004 §3) ---------------------------------------------------

export type FailureClass = { kind: 'permanent'; errorCode: string } | { kind: 'transient' };

/**
 * Só é **permanente** o que foi explicitamente classificado como tal. Qualquer erro não
 * reconhecido é transitório: na dúvida, tentar de novo (e deixar a redrive policy levar à
 * DLQ após `maxReceiveCount`) é mais seguro do que descartar uma transação financeira.
 * Erros de negócio não chegam aqui: viram `REJECTED` persistido e a mensagem é confirmada.
 */
export function classifyError(error: unknown): FailureClass {
  if (
    error instanceof ValidationError ||
    error instanceof WalletNotFoundError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InboxPayloadMismatchError
  ) {
    return { kind: 'permanent', errorCode: error.code };
  }
  return { kind: 'transient' };
}

/** Backoff exponencial com jitter: 2 s, 4 s, 8 s… (por recebimento), teto de 5 min. */
export function retryDelaySeconds(
  receiveCount: number,
  baseSeconds: number,
  capSeconds: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(receiveCount - 1, 0), 20);
  const capped = Math.min(baseSeconds * 2 ** exponent, capSeconds);
  return Math.max(1, Math.floor(capped * (0.5 + random() / 2)));
}

// ---- consumidor ---------------------------------------------------------------------------

export interface WagerConsumerOptions {
  consumerName: string;
  waitTimeSeconds: number;
  maxMessages: number;
  /** Visibility timeout da fila; o heartbeat estende para este valor. */
  visibilityTimeoutSeconds: number;
  heartbeatIntervalMs: number;
  /** Prazo para concluir mensagens em andamento no `stop()`; depois, são devolvidas à fila. */
  gracePeriodMs: number;
  retryBaseSeconds: number;
  retryCapSeconds: number;
}

export const DEFAULT_WAGER_CONSUMER_OPTIONS: WagerConsumerOptions = {
  consumerName: WAGER_CONSUMER_NAME,
  waitTimeSeconds: 20,
  maxMessages: 10,
  visibilityTimeoutSeconds: 30,
  heartbeatIntervalMs: 10_000,
  gracePeriodMs: 20_000,
  retryBaseSeconds: 2,
  retryCapSeconds: 300,
};

export interface WagerConsumerDependencies {
  queue: QueueGateway;
  deadLetters: DeadLetterPublisher;
  useCase: {
    execute(command: ProcessWagerTransactionCommand, ctx: ProcessContext): Promise<ProcessWagerTransactionResult>;
  };
  options?: Partial<WagerConsumerOptions>;
  metrics?: Metrics;
  logger?: Logger;
  faults?: FaultInjector;
  /** Jitter do backoff; injetável para testes. */
  random?: () => number;
}

type Outcome = 'done' | 'retry' | 'abandon';

/**
 * Consumidor da fila `wager-transactions.fifo` (ADR-004 §3): entrega at-least-once, efeito
 * exatamente uma vez.
 *
 * - chama o **mesmo** caso de uso do HTTP, com contexto de inbox;
 * - `DeleteMessage` só **depois do commit** (`duplicate-delivery` e replay também confirmam);
 * - erro permanente → DLQ explícita e só então `DeleteMessage`; transitório (ou não
 *   classificado) → `ChangeMessageVisibility` com backoff, sem apagar;
 * - mensagens do mesmo `MessageGroupId` num lote são processadas em sequência; falha
 *   transitória na *i*-ésima devolve as seguintes ao SQS com visibilidade 0 (ordem preservada,
 *   sem esperar o visibility timeout);
 * - heartbeat estende a visibilidade de mensagens lentas;
 * - `stop()` (SIGTERM) para de receber, conclui as em andamento até o prazo e devolve o resto.
 */
export class WagerTransactionConsumer {
  private readonly options: WagerConsumerOptions;
  private readonly metrics: Metrics;
  private readonly logger: Logger;
  private readonly faults: FaultInjector;
  private readonly random: () => number;

  private polling: Promise<void> | undefined;
  private abort = new AbortController();
  private stopping = false;
  private dead = false;
  private readonly active = new Set<ReceivedMessage>();
  /** Backoff aplicado a cada mensagem em retry: os seguintes do grupo esperam o mesmo tempo. */
  private readonly retryDelays = new Map<ReceivedMessage, number>();

  constructor(private readonly deps: WagerConsumerDependencies) {
    this.options = { ...DEFAULT_WAGER_CONSUMER_OPTIONS, ...deps.options };
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.logger = (deps.logger ?? NOOP_LOGGER).child({ component: 'wager-consumer' });
    this.faults = deps.faults ?? NOOP_FAULT_INJECTOR;
    this.random = deps.random ?? Math.random;
  }

  /** `true` depois de um `SimulatedCrashError`: o consumidor se comporta como processo morto. */
  get crashed(): boolean {
    return this.dead;
  }

  start(): void {
    if (this.polling !== undefined) return;
    this.stopping = false;
    this.dead = false;
    this.abort = new AbortController();
    this.polling = this.poll();
  }

  async stop(): Promise<void> {
    const polling = this.polling;
    if (polling === undefined) return;
    this.stopping = true;
    this.abort.abort();

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = new Promise<'grace'>((resolve) => {
      graceTimer = setTimeout(() => resolve('grace'), this.options.gracePeriodMs);
    });
    const outcome = await Promise.race([polling.then(() => 'drained' as const), graceExpired]);
    clearTimeout(graceTimer);

    if (outcome === 'grace') {
      // Não deu tempo: devolve o que ainda está em andamento. Se o commit acontecer depois,
      // a redelivery cai na inbox e é confirmada sem efeito.
      this.logger.warn('grace period expired; returning in-flight messages', { inFlight: this.active.size });
      await this.release([...this.active]);
    }
    this.polling = undefined;
  }

  private async poll(): Promise<void> {
    while (!this.stopping && !this.dead) {
      let messages: ReceivedMessage[];
      try {
        messages = await this.deps.queue.receive({
          waitTimeSeconds: this.options.waitTimeSeconds,
          maxMessages: this.options.maxMessages,
          signal: this.abort.signal,
        });
      } catch (error) {
        if (this.stopping) return;
        this.logger.error('receive failed', { error: describe(error) });
        await this.pause(1_000);
        continue;
      }
      if (messages.length > 0) await this.processBatch(messages);
    }
  }

  private async processBatch(messages: ReceivedMessage[]): Promise<void> {
    const groups = new Map<string, ReceivedMessage[]>();
    for (const message of messages) {
      this.active.add(message);
      const key = message.groupId ?? message.sqsMessageId;
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [message]);
      else list.push(message);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(group: ReceivedMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (this.dead) {
        for (const pending of group.slice(index)) this.active.delete(pending);
        return;
      }
      if (this.stopping) {
        await this.release(group.slice(index));
        return;
      }
      const outcome = await this.handle(message);
      this.active.delete(message);
      if (outcome === 'abandon') {
        this.dead = true;
        for (const pending of group.slice(index + 1)) this.active.delete(pending);
        return;
      }
      if (outcome === 'retry') {
        // Falha transitória: as seguintes do mesmo grupo voltam junto com esta (mesmo backoff),
        // na ordem de envio e sem esperar o visibility timeout da fila.
        const delay = this.retryDelays.get(message) ?? this.options.retryBaseSeconds;
        this.retryDelays.delete(message);
        await this.release(group.slice(index + 1), delay);
        return;
      }
    }
  }

  private async handle(message: ReceivedMessage): Promise<Outcome> {
    const stopHeartbeat = this.startHeartbeat(message);
    let log = this.logger.child({ sqsMessageId: message.sqsMessageId, receiveCount: message.receiveCount });
    try {
      const parsed = parseEnvelope(message.body);
      if (!parsed.ok) return await this.deadLetter(message, 'VALIDATION_ERROR', parsed.reason, log);

      const { messageId, command } = parsed.value;
      const correlationId = `sqs:${messageId}`;
      log = log.child({
        messageId,
        correlationId,
        walletId: command.walletId,
        providerId: command.providerId,
      });

      let result: ProcessWagerTransactionResult;
      try {
        result = await this.deps.useCase.execute(command, {
          correlationId,
          inbox: { consumerName: this.options.consumerName, messageId },
        });
      } catch (error) {
        const failure = classifyError(error);
        return failure.kind === 'permanent'
          ? await this.deadLetter(message, failure.errorCode, describe(error), log)
          : await this.retryLater(message, error, log);
      }

      // O commit já aconteceu. Um crash aqui deixa a mensagem em voo: a redelivery cai na inbox.
      this.faults.trigger('crash_after_commit_before_ack');
      await this.acknowledge(message, result, log);
      return 'done';
    } catch (error) {
      if (error instanceof SimulatedCrashError) return 'abandon';
      // Falha inesperada fora do caso de uso: mesmo tratamento de uma transitória (backoff),
      // para que as seguintes do grupo nunca fiquem visíveis antes desta.
      log.error('unexpected failure while handling message', { error: describe(error) });
      return await this.retryLater(message, error, log);
    } finally {
      stopHeartbeat();
    }
  }

  private async acknowledge(
    message: ReceivedMessage,
    result: ProcessWagerTransactionResult,
    log: Logger,
  ): Promise<void> {
    try {
      await this.deps.queue.delete(message.receiptHandle);
    } catch (error) {
      // Efeito já comitado: se a mensagem voltar, a inbox/idempotência a confirma sem efeito.
      log.warn('ack failed after commit; redelivery will be absorbed by the inbox', { error: describe(error) });
      return;
    }
    if (result.kind === 'duplicate-delivery') {
      log.info('duplicate delivery acknowledged without effect');
    } else {
      log.info(result.kind === 'replay' ? 'replay acknowledged' : 'transaction applied and acknowledged', {
        transactionId: result.transaction.id,
        status: result.transaction.status,
      });
    }
  }

  private async retryLater(message: ReceivedMessage, error: unknown, log: Logger): Promise<Outcome> {
    this.metrics.sqsRetry();
    const delay = retryDelaySeconds(
      message.receiveCount,
      this.options.retryBaseSeconds,
      this.options.retryCapSeconds,
      this.random,
    );
    this.retryDelays.set(message, delay);
    log.warn('transient failure; message will be retried', {
      error: describe(error),
      retryInSeconds: delay,
    });
    try {
      await this.deps.queue.changeVisibility(message.receiptHandle, delay);
    } catch (visibilityError) {
      // Sem backoff, vale o visibility timeout padrão da fila.
      log.warn('could not extend visibility for retry', { error: describe(visibilityError) });
    }
    return 'retry';
  }

  private async deadLetter(
    message: ReceivedMessage,
    errorCode: string,
    errorMessage: string,
    log: Logger,
  ): Promise<Outcome> {
    try {
      await this.deps.deadLetters.send({
        body: message.body,
        groupId: message.groupId ?? UNPARSEABLE_DLQ_GROUP,
        deduplicationId: message.sqsMessageId,
        attributes: {
          errorCode,
          errorMessage: errorMessage.slice(0, 256),
          sourceMessageId: message.sqsMessageId,
          receiveCount: message.receiveCount,
          failedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      // DLQ indisponível: a mensagem NÃO é apagada; segue como transitória e a redrive
      // policy a leva à DLQ pelo caminho nativo.
      log.error('could not send message to the dead-letter queue', { errorCode, error: describe(error) });
      return this.retryLater(message, error, log);
    }
    this.metrics.sqsDeadLettered(errorCode);
    log.error('permanent failure; message moved to the dead-letter queue', { errorCode, error: errorMessage });
    try {
      await this.deps.queue.delete(message.receiptHandle);
    } catch (error) {
      // Já está na DLQ: no pior caso há uma duplicata, barrada pela deduplicação da DLQ.
      log.warn('could not delete message after dead-lettering', { error: describe(error) });
    }
    return 'done';
  }

  /** Devolve mensagens à fila (`ChangeMessageVisibility`); sem atraso, imediatamente. */
  private async release(messages: ReceivedMessage[], delaySeconds = 0): Promise<void> {
    await Promise.allSettled(
      messages.map(async (message) => {
        this.active.delete(message);
        try {
          await this.deps.queue.changeVisibility(message.receiptHandle, delaySeconds);
        } catch (error) {
          this.logger.warn('could not return message to the queue', {
            sqsMessageId: message.sqsMessageId,
            error: describe(error),
          });
        }
      }),
    );
  }

  private startHeartbeat(message: ReceivedMessage): () => void {
    const timer = setInterval(() => {
      this.deps.queue
        .changeVisibility(message.receiptHandle, this.options.visibilityTimeoutSeconds)
        .catch((error: unknown) => {
          this.logger.warn('heartbeat failed', { sqsMessageId: message.sqsMessageId, error: describe(error) });
        });
    }, this.options.heartbeatIntervalMs);
    return () => clearInterval(timer);
  }

  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
