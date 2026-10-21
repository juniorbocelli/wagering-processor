# ADR-011 — Retenção limitada para inbox e outbox

- **Status:** Aceita
- **Data:** 2026-10-20
- **Relacionados:** ADR-003, ADR-004
- **Edital:** §6.5, §10, §11, §14 (Mensageria e falhas — 15 pts)

---

## Contexto

`inbox_messages` e `outbox_messages` (ADR-004) recebem linhas a cada operação e nunca são
limpas. Sem retenção:

- as tabelas crescem sem limite, degradando o claim da outbox e a busca da inbox
  (índices maiores, *bloat*, vacuum mais caro);
- o histórico operacional de eventos publicados se mistura ao trabalho pendente.

Forças em disputa:

1. A **inbox é o horizonte de deduplicação por `messageId`**: apagar cedo demais permite
   reprocessar uma redelivery tardia.
2. A outbox **pendente** carrega eventos confirmados ainda não publicados — apagá-la
   violaria "não perder eventos confirmados" (§3).
3. A limpeza não pode competir com o publisher nem disputar locks entre instâncias.

## Decisão

- Um worker de manutenção em **cada instância** (intervalo `RETENTION_INTERVAL_MS`,
  padrão 10 min) apaga:
  - outbox **publicada** há mais de `OUTBOX_RETENTION_HOURS` (padrão **72 h**);
  - inbox **processada** há mais de `INBOX_RETENTION_DAYS` (padrão **7 dias**).
- Linhas **pendentes nunca são apagadas** (`published_at IS NULL` fica fora do predicado).
- Lotes curtos e sem disputa:

  ```sql
  DELETE FROM outbox_messages
  WHERE id IN (
    SELECT id FROM outbox_messages
    WHERE published_at < now() - make_interval(hours => $1)
    ORDER BY published_at
    LIMIT $2                        -- RETENTION_BATCH_SIZE, padrão 1000
    FOR UPDATE SKIP LOCKED);
  ```

  O worker repete enquanto o lote vier cheio. Idem para a inbox por `processed_at`.
- Índices parciais apenas para linhas elegíveis:
  `(published_at) WHERE published_at IS NOT NULL` e `(processed_at)` na inbox.
- Métricas: `retention_deleted_total{table}`, `retention_last_run_timestamp`.

### Alternativas consideradas

| Alternativa | Avaliação |
|---|---|
| Particionamento por tempo e `DROP PARTITION` | Mais barato em volume muito alto (sem bloat), mas exige gestão de partições; é a evolução natural. |
| `DELETE` único sem lote | Transação longa, muitos locks e WAL de uma vez. |
| `pg_cron` / cron externo | Mais uma peça de infraestrutura; o worker reaproveita o ciclo de vida da aplicação. |
| Não reter (status quo) | Crescimento ilimitado. |

## Consequências e Trade-offs

### Ganhos

- Tabelas limitadas ao volume da janela de retenção; claim e lookup estáveis.
- Sem coordenação entre instâncias (`SKIP LOCKED`) e sem interferir no publisher.

### Custos

- Mais um worker e três parâmetros de configuração.
- Eventos publicados ficam disponíveis para diagnóstico só por 72 h.

### Limitações conhecidas

- A janela da inbox (7 dias) precisa permanecer muito maior que qualquer redelivery do
  SQS (retenção máxima de mensagem: 14 dias, mas `maxReceiveCount=5` com backoff ≤ 5 min
  limita a vida útil prática a minutos). Mesmo após a janela, a **idempotency key** em
  `wager_transactions` — que nunca é apagada — impede efeito financeiro duplicado.
