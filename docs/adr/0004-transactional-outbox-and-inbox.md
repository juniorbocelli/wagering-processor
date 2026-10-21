# ADR-004 — Consistência transacional com Transactional Outbox e padrão Inbox

- **Status:** Aceita
- **Data:** 2026-10-20
- **Revisão:** 2026-10-20 — outbox com ordem por wallet (claim da cabeça + lease), preservação de ordem do grupo FIFO no consumidor e erro desconhecido como transitório, após análise comparativa com implementação de referência
- **Relacionados:** ADR-002, ADR-003, ADR-005
- **Edital:** §3, §5.3, §5.4, §6.5, §7.1, §10, §11, §12, §13 (Integração; Concorrência 5–8), §14 (Mensageria e falhas — 15 pts; eliminatória "publicação de evento antes do commit")

---

## Contexto

O sistema tem duas fronteiras assíncronas:

- **Entrada**: fila `wager-transactions.fifo` (com DLQ `wager-transactions-dlq.fifo`),
  entrega at-least-once, redelivery após *visibility timeout*.
- **Saída**: eventos de integração (`WagerTransactionProcessed`,
  `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`).

O problema clássico de **dual write**: PostgreSQL e SQS não compartilham transação.

| Ordem | Falha | Consequência |
|---|---|---|
| Publica → commit | commit falha | evento de algo que **não aconteceu** (proibido, §5.4, eliminatório) |
| Commit → publica | processo morre entre os dois | evento confirmado **perdido** (viola invariante §3) |
| Commit → ack SQS | morre antes do ack | redelivery → **efeito duplicado** sem dedup persistente |

Requisitos adicionais: consumidor reutiliza **o mesmo use case** do HTTP; dedup por
`(consumerName, messageId)` persistente; ack **somente após o commit**; distinguir erros
de negócio / transitórios / permanentes; limite de tentativas antes da DLQ; `SIGTERM`
gracioso; publishers concorrentes sobre a mesma outbox sem perda nem duplicação
indefinida; o cenário "commit → crash → outra instância publica → duplicata segura".

## Decisão

### 1. Uma única transação SQL por operação de negócio

```text
BEGIN
  [SQS]  INSERT inbox_messages (consumer_name, message_id, payload_hash) ON CONFLICT DO NOTHING
  SELECT wallets ... FOR UPDATE                                  -- ADR-002
  checagem de idempotência sob lock                               -- ADR-003
  INSERT wager_transactions (status final ou PENDING_REFERENCE)
  [se move saldo] INSERT wallet_ledger_entries; UPDATE wallets (balance, version+1)
  INSERT outbox_messages (1..N eventos)
COMMIT
→ só então: ack SQS (DeleteMessage) / resposta HTTP
```

Ou **tudo** é confirmado junto, ou **nada**. O use case recebe um contexto opcional de
inbox; HTTP e SQS chamam o mesmo `ProcessWagerTransactionUseCase`.

### 2. Inbox (deduplicação de entrega)

```sql
CREATE TABLE inbox_messages (
  consumer_name VARCHAR(64)  NOT NULL,
  message_id    VARCHAR(128) NOT NULL,
  payload_hash  CHAR(64)     NOT NULL,
  received_at   TIMESTAMPTZ  NOT NULL,
  processed_at  TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY (consumer_name, message_id)
);
```

- O registro só existe se a transação de negócio **comitou** → existência = processado.
- Duplicata concorrente: o segundo `INSERT` bloqueia no índice único até o primeiro
  comitar e então retorna conflito → **ack sem efeito** (`inbox_duplicates_total`).
- Mesmo `messageId` com `payload_hash` diferente → mensagem corrompida/reuso indevido →
  **erro permanente** (DLQ) e log de alerta.
- Duas camadas complementares: **inbox** deduplica *entregas* (mesmo `messageId`);
  **idempotency key** (ADR-003) deduplica *operações* (provedor reenviando a mesma
  operação com novo `messageId`, ou por HTTP).

### 3. Consumidor SQS — classificação de erros

| Classe | Exemplos | Ação |
|---|---|---|
| **Negócio** (terminal) | saldo insuficiente, referência inválida, moeda divergente | transação `REJECTED` + inbox + outbox comitados → **ack** |
| **Replay/duplicata** | inbox hit, idempotency replay | **ack** |
| **Transitório** | PG indisponível, `lock_timeout`, deadlock, throttling SQS, **qualquer erro não classificado** | **não** ack; `ChangeMessageVisibility` com backoff exponencial + jitter (2s, 4s, 8s… teto 5 min); após `maxReceiveCount = 5` a *redrive policy* move para a DLQ |
| **Permanente** | JSON inválido, schema inválido, `type` desconhecido, `kind = OPENING`, wallet inexistente, conflito de idempotência (409), conflito de inbox | envio explícito à DLQ com atributos de diagnóstico (`errorCode`, `receiveCount`) e então `DeleteMessage` |

**Erro desconhecido é transitório, por princípio.** Na dúvida, é mais seguro tentar de novo
(e deixar a redrive policy levar à DLQ após 5 recebimentos) do que descartar uma
transação financeira. Só é permanente o que foi **explicitamente** classificado como tal.

`MessageGroupId = walletId` reduz contenção (otimização, §8). Trade-off aceito: uma
mensagem em retry bloqueia o seu grupo (*head-of-line*), mas apenas daquela wallet.

**Preservação da ordem do grupo dentro de um lote recebido.** Um `ReceiveMessage` pode
devolver várias mensagens do mesmo grupo. Elas são processadas **sequencialmente** (grupos
diferentes em paralelo). Se a mensagem *i* falha transitoriamente, as seguintes do mesmo
grupo **não** são processadas e recebem `ChangeMessageVisibility(0)` imediatamente: o FIFO
só as reentrega depois de *i*, mantendo a ordem, e o grupo não fica parado até o
visibility timeout expirar por causa de mensagens lidas e não apagadas.

**Visibility timeout** (30 s) > `lock_timeout` + `statement_timeout`; mensagens longas
têm a visibilidade estendida por *heartbeat*.

**`SIGTERM`**: (1) para de fazer `ReceiveMessage`; (2) aguarda mensagens em andamento até
o *grace period* (20 s); (3) para as não iniciadas/não concluídas,
`ChangeMessageVisibility(0)` devolve à fila imediatamente; (4) fecha pool do PG.
NestJS `enableShutdownHooks()` + `OnApplicationShutdown`.

### 4. Outbox — publicação ordenada por wallet com *claim da cabeça + lease* via `SKIP LOCKED`

```sql
CREATE TABLE outbox_messages (
  id              UUID PRIMARY KEY,         -- = eventId
  seq             BIGINT       GENERATED ALWAYS AS IDENTITY UNIQUE,
  aggregate_id    UUID         NOT NULL,    -- walletId
  event_type      VARCHAR(64)  NOT NULL,
  event_version   SMALLINT     NOT NULL,
  payload         JSONB        NOT NULL,    -- envelope IntegrationEvent.toJSON()
  occurred_at     TIMESTAMPTZ  NOT NULL,
  attempts        INTEGER      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ  NOT NULL,
  locked_until    TIMESTAMPTZ  NULL,
  locked_by       VARCHAR(128) NULL,
  published_at    TIMESTAMPTZ  NULL,
  last_error      VARCHAR(512) NULL
);
CREATE INDEX ix_outbox_pending_by_aggregate ON outbox_messages (aggregate_id, seq) WHERE published_at IS NULL;
CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
```

**Por que `seq` ordena corretamente por wallet:** toda escrita que gera eventos de uma
wallet acontece sob o lock dessa wallet (ADR-002), então os valores de `seq` de uma mesma
wallet são alocados e comitados em ordem. Entre wallets, `seq` não precisa de ordem.

Ciclo do worker (roda em **todas** as instâncias):

```sql
-- 1) CLAIM (transação curta): trava a CABEÇA de cada wallet e reserva as seguintes
WITH heads AS (
  SELECT o.aggregate_id, o.seq
  FROM outbox_messages o
  WHERE o.published_at IS NULL
    AND o.next_attempt_at <= now()
    AND (o.locked_until IS NULL OR o.locked_until < now())
    AND NOT EXISTS (                         -- é o evento pendente mais antigo da wallet
      SELECT 1 FROM outbox_messages p
      WHERE p.aggregate_id = o.aggregate_id AND p.published_at IS NULL AND p.seq < o.seq)
  ORDER BY o.seq
  LIMIT 10
  FOR UPDATE OF o SKIP LOCKED
), batch AS (
  SELECT f.id FROM heads h
  CROSS JOIN LATERAL (
    SELECT id FROM outbox_messages
    WHERE aggregate_id = h.aggregate_id AND published_at IS NULL AND seq >= h.seq
    ORDER BY seq LIMIT 20
  ) f
)
UPDATE outbox_messages
   SET locked_until = now() + interval '30 seconds', locked_by = $instance
 WHERE id IN (SELECT id FROM batch)
RETURNING *;
-- 2) PUBLISH fora de transação, por wallet, em ordem de seq:
--    SendMessageBatch (≤10) → wallet-events.fifo
--    MessageGroupId = aggregate_id, MessageDeduplicationId = event id
-- 3) MARK: published_at = now() para as entradas enviadas com sucesso (AND locked_by = $instance)
--    falha na entrada i: i → attempts+1, next_attempt_at = now() + backoff, lease liberado;
--    seguintes da mesma wallet → apenas lease liberado (continuam atrás de i)
```

- **Ordem por wallet garantida:** só a **cabeça** (evento pendente mais antigo) de uma wallet
  pode ser reivindicada. Enquanto ela estiver com lease ou em backoff, nenhum outro
  publisher alcança os eventos seguintes daquela wallet — nem falha de publicação nem
  publishers concorrentes fazem um evento posterior sair antes de um anterior.
- `SKIP LOCKED` permite **N publishers concorrentes** sem bloqueio mútuo e sem pegar a
  mesma cabeça no mesmo instante; wallets diferentes são publicadas em paralelo.
- O *lease* (`locked_until`) evita manter transação e conexão abertas durante a chamada
  de rede ao SQS (que pode estar lento ou indisponível) e devolve o trabalho
  automaticamente se o publisher morrer.
- Crash entre publicar e marcar → lease expira → a cabeça e as seguintes são
  republicadas, **na mesma ordem e com os mesmos `eventId`**. Garantia efetiva:
  **at-least-once ordenado por wallet**; consumidores deduplicam por `eventId` (o FIFO
  deduplica na janela de 5 min como otimização) e podem conferir `walletVersion`.
- **Nunca descartamos** evento confirmado: após 10 tentativas o evento continua sendo
  re-tentado (teto de backoff 5 min) e entra em `outbox_stuck_total` para alerta.
- `outbox_lag_seconds = now() − min(occurred_at) WHERE published_at IS NULL`.
- Trigger impede alterar `payload`, `event_type`, `aggregate_id`, `seq` após o insert.

### 5. Worker de referências pendentes (§7.1)

Mesmo padrão `FOR UPDATE SKIP LOCKED` sobre `wager_transactions WHERE status =
'PENDING_REFERENCE' AND next_reference_attempt_at <= now()`, reprocessando via o mesmo
caminho transacional (lock da wallet). Backoff exponencial (1 s → teto 60 s), limite
de **12 tentativas / TTL 15 min**; esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` e
evento `WagerTransactionRejected`. Otimização: ao processar uma transação, dependentes
pendentes da **mesma wallet** (já travada) são resolvidos na mesma transação.

### 6. Matriz de recuperação

| Ponto de crash | Estado após | Recuperação |
|---|---|---|
| Antes do commit | nada gravado | SQS redelivery / provedor re-tenta com a mesma key |
| Após commit, antes do ack | efeitos + inbox gravados | redelivery → inbox hit → ack sem efeito |
| Após commit, antes de publicar | outbox pendente | qualquer instância publica |
| Após publicar, antes de marcar | outbox com lease | lease expira → republica mesmo `eventId` |
| PG indisponível | consumidor não comita | retry com backoff → DLQ após 5 recebimentos |
| SQS indisponível | outbox acumula | backoff; nada se perde; `outbox_lag` sobe |

## Consequências e Trade-offs

### Ganhos

- **Elimina dual write**: evento existe ⇔ fato financeiro comitado.
- **Exactly-once de efeito** no consumo (inbox + idempotência + transação única), mesmo
  com entrega at-least-once.
- **Escalabilidade horizontal** de publishers e workers sem coordenação externa.
- **Ordem de publicação por wallet** sem prender conexão durante I/O de rede.
- Recuperação após crash é **automática** e não depende da instância que falhou.

### Custos

- **Latência de publicação** (intervalo de polling do worker, ~200–500 ms) e carga de
  polling no banco (mitigada pelo índice parcial).
- Tabela de outbox cresce; exige rotina de expurgo de `published_at` antigos.
- Mais uma escrita por transação de negócio.
- Consumidores downstream **precisam** ser idempotentes por `eventId`.

### Limitações conhecidas

- Publicação at-least-once, não exactly-once.
- Um evento "cabeça" que falha repetidamente **bloqueia os eventos seguintes da mesma
  wallet** (head-of-line) até ser publicado — preço consciente da ordem; visível em
  `outbox_stuck_total`. Outras wallets não são afetadas.
- O claim faz uma subconsulta `NOT EXISTS` por candidato (coberta pelo índice parcial
  `(aggregate_id, seq)`); custo a ser medido no teste de carga.
- `LISTEN/NOTIFY` para reduzir latência de polling fica como evolução.
- Expurgo de outbox/inbox tratado no [ADR-011](0011-bounded-retention-inbox-outbox.md).
