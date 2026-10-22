# ADR-009 — Observabilidade: logs estruturados e catálogo de métricas

- **Status:** Aceita
- **Data:** 2026-10-22
- **Relacionados:** ADR-004, ADR-008, ADR-011, ADR-012
- **Edital:** §12, §14 (Observabilidade)

---

## Contexto

Um processador financeiro assíncrono falha de formas silenciosas: mensagem presa em retry,
outbox acumulando, lock de wallet esperando. Sem sinais explícitos, o diagnóstico depende
de reproduzir o problema. Ao mesmo tempo, logs de um sistema financeiro **não podem**
carregar valores nem payloads de negócio.

## Decisão

### 1. Logs estruturados

- `pino`, uma linha JSON por evento, atrás da porta `Logger` (a aplicação não conhece o
  pino).
- A aplicação só registra **identificadores**: `correlationId`, `messageId`,
  `sqsMessageId`, `transactionId`, `walletId`, `providerId`, `eventId`, `eventType`,
  `attempts`, `errorCode`.
- `redact` (`money`, `amount`, `payload`, `body`) é uma segunda barreira, não a primeira.
- `correlationId` nasce na borda (HTTP ou `sqs:<messageId>`) e acompanha a transação e os
  eventos emitidos.

### 2. Métricas (Prometheus, `prom-client`, registro próprio)

| Métrica | Tipo | Rótulos | Sinaliza |
|---|---|---|---|
| `wager_transactions_total` | counter | `status`, `kind` | volume por desfecho |
| `idempotency_replays_total` | counter | — | reenvios absorvidos |
| `idempotency_conflicts_total` | counter | — | reuso indevido de chave |
| `inbox_duplicates_total` | counter | — | redeliveries absorvidas |
| `sqs_retries_total` | counter | — | falhas transitórias do consumidor |
| `sqs_dlq_messages_total` | counter | `error_code` | falhas permanentes |
| `wallet_lock_wait_seconds` | histogram | — | contenção por wallet |
| `wallet_lock_timeouts_total` | counter | — | `lock_timeout` esgotado |
| `wager_processing_duration_seconds` | histogram | — | latência de processamento |
| `outbox_lag_seconds` | gauge | — | idade do evento pendente mais antigo |
| `outbox_stuck_total` | counter | — | evento com 10+ tentativas (segue sendo retentado) |
| `retention_deleted_total` | counter | `table` | linhas expurgadas |

- Os rótulos têm **cardinalidade limitada** (enumerações fechadas); nunca `walletId`,
  `transactionId` ou `messageId`.
- `outbox_lag_seconds` é lido do banco a cada *scrape*, não mantido em memória: continua
  correto após restart e entre instâncias.
- As métricas entram por uma porta `Metrics` com implementação nula; testes de unidade não
  dependem do `prom-client`.

### 3. Health checks

Liveness (processo) e readiness (PostgreSQL e SQS alcançáveis) são expostos pela camada
HTTP, junto com o endpoint de métricas.

## Consequências e Trade-offs

### Ganhos

- Cada modo de falha do ADR-004 §6 tem um sinal correspondente.
- Nenhum dado financeiro em log, por construção e por redação.

### Custos

- Contadores de processo são por instância: a agregação é do coletor.
- `wager_transactions_total` não conta resoluções em cascata dentro de uma transação
  (ADR-008).

### Limitações conhecidas

- Sem tracing distribuído; o `correlationId` cobre a correlação entre log, evento e
  transação.
- `outbox_lag_seconds` faz uma leitura por *scrape* (coberta pelo índice parcial de
  pendentes).
