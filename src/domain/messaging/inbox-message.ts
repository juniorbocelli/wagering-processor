import { DomainError } from '../shared/domain-error.ts';

export class InvalidInboxStateError extends DomainError {
  readonly code = 'INVALID_INBOX_STATE';

  constructor(message: string) {
    super(message);
  }
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

export type ReceiveInboxProps = Pick<
  InboxMessageState,
  'messageId' | 'consumerName' | 'payloadHash' | 'receivedAt'
>;

/**
 * Registro de deduplicação de entrega por `(consumerName, messageId)` (ADR-004 §2).
 * Persistido na mesma transação do efeito de negócio: a existência da linha significa
 * "processada" — por isso o repositório grava `processedAt` (ou, na falta, `receivedAt`).
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.length === 0 || props.consumerName.length === 0) {
      throw new InvalidInboxStateError('messageId and consumerName must not be empty');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvalidInboxStateError('Inbox message is already processed');
    }
    this._processedAt = at;
  }
}
