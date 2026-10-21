export const WagerTransactionKind = {
  Opening: 'OPENING', // interno: crédito de abertura da wallet
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;

export type WagerTransactionKind = (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Pending: 'PENDING', // aceita, ainda não aplicada
  PendingReference: 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed: 'PROCESSED', // aplicada (terminal)
  Rejected: 'REJECTED', // violação de regra de negócio (terminal)
  Failed: 'FAILED', // erro permanente não-negocial (terminal, auditável)
} as const;

export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];
