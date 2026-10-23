# Contrato de mensageria

A API HTTP está em [openapi.yaml](openapi.yaml), servida em `/docs`. Este documento cobre o lado assíncrono: a fila de entrada, a DLQ e os eventos de integração publicados.

| Fila                          | Tipo | Direção | `MessageGroupId`       |
| ----------------------------- | ---- | ------- | ---------------------- |
| `wager-transactions.fifo`     | FIFO | entrada | `walletId`             |
| `wager-transactions-dlq.fifo` | FIFO | saída   | o da mensagem original |
| `wallet-events.fifo`          | FIFO | saída   | `walletId`             |

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

- `data` tem os mesmos campos do `POST /wagering/transactions`, mais `idempotencyKey` (na API HTTP ela vem no header). `referenceExternalTransactionId` é obrigatório em `REFUND` e `ROLLBACK`; nos demais, omita o campo.
- `messageId` identifica a mensagem para a inbox. Reenviar o mesmo `messageId` com o mesmo corpo é seguro (replay); com outro corpo é falha permanente.
- Use `MessageGroupId = walletId`: o FIFO entrega mensagens de uma mesma wallet em ordem e a ordem reduz contenção. A correção não depende disso: o banco serializa por wallet de qualquer forma.
- `traceparent` (W3C) opcional como atributo da mensagem continua o trace do produtor.

### Resultado do processamento

| Resultado                                                                                                                                 | O que acontece com a mensagem                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Processada, rejeitada por regra de negócio ou `PENDING_REFERENCE`                                                                         | apagada (ack) depois do commit                                                                    |
| Já vista pela inbox (redelivery)                                                                                                          | apagada; nada é reaplicado                                                                        |
| Falha permanente: JSON ou schema inválido, `kind` desconhecido ou `OPENING`, valor inválido, wallet inexistente, conflito de idempotência | copiada para a DLQ com os atributos `failureCode` e `failureReason`, e apagada da fila de entrada |
| Falha transitória: banco fora, deadlock, timeout                                                                                          | não é apagada; a visibilidade é estendida com backoff (2 s, 4 s, 8 s... até 60 s)                 |
| 5 recebimentos sem ack                                                                                                                    | a redrive policy do SQS move para a DLQ                                                           |

## Saída: eventos de integração

Publicados em `wager-events.fifo` pelo transactional outbox, depois do commit da transação que os gerou. Atributo de mensagem `eventType`; `MessageDeduplicationId = eventId`.

### Envelope

```json
{
  "eventId": "0192f291-5a0b-7d2e-b1c4-2e6f8a9b0c11",
  "eventType": "WalletBalanceChanged",
  "aggregateId": "0192f290-1c55-7a3e-9a41-3f1b6e2c9d10",
  "correlationId": "0192f291-59ff-7aa0-8d33-6c1e2b4f7a90",
  "causationId": "msg-123",
  "occurredAt": "2026-07-29T15:00:00.120Z",
  "version": 1,
  "data": {}
}
```

| Campo           | Significado                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventId`       | identificador único (UUIDv7); use para deduplicar                                                                                             |
| `aggregateId`   | `walletId`; também é o `MessageGroupId`                                                                                                       |
| `correlationId` | o da requisição HTTP ou da mensagem que originou o evento                                                                                     |
| `causationId`   | opcional: o `messageId` da mensagem SQS que originou o evento, ou a transação reavaliada pelo worker de referências; ausente em chamadas HTTP |
| `version`       | versão do schema de `data` para aquele `eventType`; mudanças incompatíveis geram nova versão                                                  |

### Eventos

| `eventType`                        | Quando                                                                               | `data`                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WagerTransactionProcessed`        | qualquer transação aplicada, inclusive `LOSS`                                        | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, `referenceTransactionId`, `balance` |
| `WagerTransactionRejected`         | rejeição de negócio, inclusive `REFERENCE_NOT_FOUND` depois de esgotar as tentativas | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `money`, `failureCode`                                                        |
| `WagerTransactionPendingReference` | primeira vez que a referência não é encontrada                                       | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `kind`, `referenceExternalTransactionId`, `attempts`, `nextCheckAt`                   |
| `WalletBalanceChanged`             | somente quando o saldo muda, inclusive o crédito de abertura                         | `walletId`, `transactionId`, `direction` (`DEBIT`/`CREDIT`), `money`, `balanceBefore`, `balanceAfter`, `walletVersion`                                    |

### Garantias para quem consome

- **At-least-once.** Um evento pode chegar mais de uma vez (por exemplo, se a instância cair depois de publicar e antes do commit). Deduplique por `eventId`.
- **Ordem por wallet.** Eventos de uma mesma wallet saem na ordem em que foram gravados, mesmo com vários publishers e com falhas de publicação. `walletVersion` é monotônico e permite descartar eventos de saldo antigos.
- **Nunca antes do commit.** Um evento só existe se a mudança que ele descreve foi confirmada no banco.

Detalhes de implementação em [design/messaging.md](../design/messaging.md).
