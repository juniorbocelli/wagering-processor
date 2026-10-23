# Contrato de Mensageria Assíncrona

A API HTTP está especificada em [`openapi.yaml`](openapi.yaml) e servida interativamente em `/docs`. Este documento descreve o lado assíncrono: a fila de entrada, a DLQ e os eventos de integração publicados via Transactional Outbox.

| Fila                          | Tipo | Direção | `MessageGroupId`                                    |
| ----------------------------- | ---- | ------- | --------------------------------------------------- |
| `wager-transactions.fifo`     | FIFO | entrada | `walletId`                                          |
| `wager-transactions-dlq.fifo` | FIFO | saída   | o da mensagem original (`dlq-unparseable` se vazio) |
| `wallet-events.fifo`          | FIFO | saída   | `walletId` (`aggregateId`)                          |

## Entrada: `WagerTransactionRequested`

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-456",
    "idempotencyKey": "provider-a:transaction-456",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f290-1c55-7a3e-9a41-3f1b6e2c9d10",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

- `data` contém os mesmos campos do `POST /wagering/transactions`, acrescidos de `idempotencyKey` (que na API HTTP vem no header `Idempotency-Key`). `referenceExternalTransactionId` é obrigatório em `REFUND` e `ROLLBACK`, e opcional em `WIN` e `LOSS`.
- `messageId` identifica a entrega na tabela `inbox_messages` pela chave composta `(consumerName, messageId)`. Reenviar o mesmo `messageId` com o mesmo payload é absorvido sem efeito (`duplicate-delivery`); com payload divergente é classificado como falha permanente (`INBOX_PAYLOAD_MISMATCH`) e movido para a DLQ.
- Recomenda-se `MessageGroupId = walletId`: o SQS FIFO entrega mensagens de uma mesma wallet em ordem, reduzindo contenção de lock. A correção financeira não depende disso, pois o PostgreSQL serializa por `walletId` com `SELECT ... FOR UPDATE`.

### Resultado do processamento

| Resultado                                                                                                                                                           | O que acontece com a mensagem                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processada (`PROCESSED`), rejeitada por regra de negócio (`REJECTED`) ou `PENDING_REFERENCE`                                                                        | Apagada (`DeleteMessage` / ack) somente após o commit da transação SQL                                                                                           |
| Já vista pela inbox (`duplicate-delivery`) ou replay de idempotência (`replay`)                                                                                     | Apagada sem reaplicar efeitos                                                                                                                                    |
| Falha permanente (`VALIDATION_ERROR`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_TRANSACTION_ID_REUSED`, `INBOX_PAYLOAD_MISMATCH`)                     | Publicada na DLQ com o corpo original intacto e atributos `errorCode`, `errorMessage`, `sourceMessageId`, `receiveCount`, `failedAt`, e apagada da fila principal |
| Falha transitória (`TRANSIENT_FAILURE`, lock timeout, banco indisponível, deadlock)                                                                                 | Não é apagada; visibilidade alterada (`ChangeMessageVisibility`) com backoff exponencial + jitter (base 2 s, teto 300 s)                                          |
| 5 recebimentos sem ack (`maxReceiveCount = 5`)                                                                                                                      | A redrive policy nativa do SQS move para `wager-transactions-dlq.fifo`                                                                                           |

## Saída: Eventos de Integração

Publicados na fila `wallet-events.fifo` pelo `OutboxPublisherWorker` somente após o commit da transação SQL. Cada mensagem leva o atributo `eventType`, `MessageGroupId = aggregateId` (`walletId`) e `MessageDeduplicationId = eventId`.

### Envelope (`IntegrationEvent`)

```json
{
  "eventId": "0192f291-5a0b-7d2e-b1c4-2e6f8a9b0c11",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "0192f290-1c55-7a3e-9a41-3f1b6e2c9d10",
  "correlationId": "sqs:msg-123",
  "causationId": "msg-123",
  "occurredAt": "2026-07-29T15:00:00.120Z",
  "version": 1,
  "data": {}
}
```

| Campo           | Significado                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `eventId`       | Identificador único do evento (UUIDv7); chave de deduplicação para consumidores                                            |
| `aggregateId`   | `walletId`; usado como `MessageGroupId` para preservar a ordem causal por carteira                                         |
| `correlationId` | Identificador de correlação da requisição HTTP ou da mensagem SQS                                                          |
| `causationId`   | Opcional: `messageId` da mensagem SQS, `correlationId` HTTP ou `transactionId` que disparou a resolução em cascata/worker |
| `version`       | Versão do schema de `data` (`1`)                                                                                           |

### Catálogo de Eventos

| `eventType`                        | Quando                                                                               | Campos de `data`                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WagerTransactionProcessed`        | Qualquer transação aplicada (`PROCESSED`), inclusive `OPENING` e `LOSS`              | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, `referenceTransactionId`, `balanceAfter`, `walletVersion`, `processedAt` |
| `WagerTransactionRejected`         | Transação rejeitada por regra de negócio (`REJECTED`), inclusive `REFERENCE_NOT_FOUND` | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, `failureCode`, `rejectedAt`                                 |
| `WagerTransactionPendingReference` | Aceite inicial quando a transação referenciada ainda não existe                      | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `money`, `referenceExternalTransactionId`, `nextAttemptAt`                                            |
| `WalletBalanceChanged`             | Somente quando o saldo muda (inclusive crédito de abertura `OPENING`)                | `walletId`, `transactionId`, `direction` (`DEBIT`/`CREDIT`), `money`, `balanceBefore`, `balanceAfter`, `walletVersion`                                                            |

### Garantias para Consumidores

- **At-least-once:** Eventos podem ser entregues mais de uma vez se o publisher sofrer crash entre o envio ao SQS e a marcação de `published_at`. Consumidores devem deduplicar por `eventId`.
- **Ordem causal por wallet:** O `OutboxPublisherWorker` reivindica a cabeça de cada carteira (`FOR UPDATE OF o SKIP LOCKED`) e publica sequencialmente por `seq`. Se a publicação da cabeça falhar, os eventos subsequentes da mesma carteira aguardam atrás dela sem bloquear outras carteiras ([ADR-004](../adr/0004-transactional-outbox-and-inbox.md)).
- **Nunca antes do commit:** Eventos são gravados em `outbox_messages` na mesma transação SQL que altera o saldo e o ledger.
