# Runbook dos alertas

Uma seção por alerta de `docker/observability/alerts.yml`; o `runbook_url` de cada alerta aponta para cá. Cada seção diz o que o alerta significa, qual o impacto, como investigar e como mitigar.

Ferramentas usadas abaixo, no ambiente do compose:

```bash
docker compose logs -f app-1 app-2 app-3                     # logs JSON das réplicas
docker compose exec postgres psql -U wagering wagering        # banco
docker compose exec localstack awslocal sqs ...               # filas
```

- Grafana: http://localhost:3100 (dashboard **Wagering service**)
- Prometheus: http://localhost:9090/alerts
- Jaeger: http://localhost:16686

---

## WalletBalanceDivergence

**Severidade:** critical

**Significado.** A última reconciliação completa encontrou wallets cujo saldo armazenado difere do ledger da wallet ou da conta do jogador no razão. Com os triggers do banco ativos, isso só acontece por escrita com os triggers desligados (`session_replication_role = replica`), restore parcial ou corrupção.

**Impacto.** O saldo exibido ao jogador pode estar errado. Novas apostas nessa wallet continuam sendo validadas pelo trigger de corrente do ledger e tendem a falhar.

**Investigação.**

1. Encontre as wallets no log de erro `wallet balance diverges from ledger` (campos `walletId` e `difference`). O log `wallet reconciliation scan completed` com nível `error` traz o total.
2. Confirme com `POST /wallets/<walletId>/reconciliation` (papel `operator`), que devolve `storedBalance`, `calculatedBalance` e `journalBalance`.
3. Descubra qual das três fontes está errada. Se ledger e razão concordam entre si, o saldo da wallet foi alterado por fora:
   ```sql
   SELECT balance, version, updated_at FROM wallets WHERE id = '<walletId>';
   SELECT sequence, balance_before, balance_after, created_at
     FROM wallet_ledger_entries WHERE wallet_id = '<walletId>' ORDER BY sequence DESC LIMIT 5;
   ```
4. Verifique quem tinha acesso de escrita direto ao banco no período.

**Mitigação.** **Não** corrija o saldo com `UPDATE`: a reconciliação não corrige nada de propósito ([ADR 0012](../adr/0012-periodic-reconciliation-detect-not-correct.md)). A correção é uma decisão de negócio, registrada como um lançamento de ajuste auditável. O alerta para sozinho quando a próxima varredura não encontrar divergências.

---

## ReconciliationStale

**Severidade:** warning

**Significado.** Nenhuma instância completou uma reconciliação completa nos últimos 30 minutos (o intervalo normal é de 5 minutos).

**Impacto.** Divergências deixariam de ser detectadas. Não afeta o processamento de transações.

**Investigação.**

1. Procure nos logs `ReconciliationWorker tick failed`, que traz a mensagem de erro da varredura.
2. Verifique se alguma sessão está segurando o advisory lock da varredura (chave `7316001`) por muito tempo:
   ```sql
   SELECT pid, state, now() - xact_start AS duração, query
     FROM pg_stat_activity
    WHERE pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 7316001);
   ```
3. Confira se as instâncias estão no ar (`WageringInstanceDown`) e com `WORKERS_ENABLED=true`.

**Mitigação.** Se uma sessão travada segura o lock, `SELECT pg_terminate_backend(<pid>)` libera; a próxima instância assume na rodada seguinte. Se a varredura está demorando mais que o intervalo por volume, aumente `RECONCILIATION_INTERVAL_MS`.

---

## OutboxLagHigh

**Severidade:** warning

**Significado.** O evento mais antigo ainda não publicado tem mais de 30 segundos, por 2 minutos seguidos.

**Impacto.** Consumidores dos eventos (`wager-events.fifo`) recebem as notificações com atraso. O processamento de transações e os saldos não são afetados.

**Investigação.**

1. No Grafana, painel **Outbox**: o volume pendente está crescendo (publisher não acompanha a carga) ou parado (publisher travado)?
2. Procure falhas de publicação nos logs (`outbox publication failed, will retry`) e veja o alerta `OutboxPublishFailures`.
3. Veja se uma wallet concentra o atraso:
   ```sql
   SELECT aggregate_id, count(*), min(occurred_at)
     FROM outbox_messages WHERE published_at IS NULL
    GROUP BY aggregate_id ORDER BY count(*) DESC LIMIT 10;
   ```

**Mitigação.** Carga acima da capacidade: adicione instâncias (cada uma roda um publisher). Uma única wallet muito quente é limitada a 20 eventos por ciclo, por design, para preservar a ordem.

---

## OutboxStuck

**Severidade:** critical

**Significado.** Há eventos sem publicar há mais de 5 minutos.

**Impacto.** Sistemas que dependem dos eventos (saldo exibido, antifraude, contabilidade externa) estão desatualizados.

**Investigação.** As mesmas de `OutboxLagHigh`, com foco em:

1. SQS acessível? `curl -s localhost:3001/health/ready` mostra `sqs: down` quando não.
2. `last_error` e `attempts` das mensagens mais antigas:
   ```sql
   SELECT id, event_type, attempts, last_error, next_attempt_at
     FROM outbox_messages WHERE published_at IS NULL ORDER BY sequence LIMIT 10;
   ```

**Mitigação.** Restabeleça o acesso ao SQS; o publisher retoma sozinho, com backoff de até 60 s. Nada se perde: os eventos estão no banco.

---

## OutboxPublishFailures

**Severidade:** warning

**Significado.** Publicações da outbox estão falhando continuamente há 5 minutos.

**Impacto.** Os eventos afetados ficam pendentes e são tentados de novo com backoff; o atraso cresce até disparar `OutboxLagHigh`.

**Investigação.** Leia `last_error` na `outbox_messages` (consulta em `OutboxStuck`). Erros comuns: fila inexistente ou URL errada em `SQS_EVENTS_QUEUE_URL`, credenciais, mensagem acima de 256 KB.

**Mitigação.** Corrija a configuração e reinicie as instâncias, se necessário. As mensagens pendentes saem em ordem por wallet.

---

## DeadLetterQueueNotEmpty

**Severidade:** warning

**Significado.** Há mensagens na DLQ `wager-transactions-dlq.fifo`: falhas permanentes (payload inválido, wallet inexistente, conflito de idempotência) ou mensagens que esgotaram 5 recebimentos.

**Impacto.** As transações dessas mensagens **não foram aplicadas**. O provedor não recebe um evento de resultado para elas.

**Investigação.**

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names All --message-attribute-names All --max-number-of-messages 10
```

O atributo `failureCode` diz o motivo (`INVALID_MESSAGE`, `INVALID_MONEY`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, ...), e `failureReason` dá o detalhe. Mensagens sem esses atributos vieram da redrive policy (falhas transitórias repetidas).

**Mitigação.**

- Erro do provedor (payload, wallet): devolva ao provedor para correção e apague a mensagem da DLQ.
- Falha transitória já resolvida: faça redrive para a fila de entrada. É seguro: inbox e chave de idempotência impedem efeito duplicado.
  ```bash
  docker compose exec localstack awslocal sqs start-message-move-task \
    --source-arn arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo
  ```

---

## SqsRetriesSpiking

**Severidade:** warning

**Significado.** Mais de uma mensagem por segundo está sendo devolvida à fila por falha transitória.

**Impacto.** Aumenta a latência do processamento assíncrono; se persistir, mensagens chegam à DLQ por esgotar os recebimentos.

**Investigação.** Os logs do consumidor trazem o `failureCode` de cada retry. Causas comuns: banco indisponível ou lento, deadlock, timeout de lock em wallets muito disputadas (veja `WalletLockContention`).

**Mitigação.** Trate a causa no banco. O backoff (2 s a 60 s) já reduz a pressão sozinho.

---

## WageringInstanceDown

**Severidade:** critical

**Significado.** O Prometheus não consegue coletar `/metrics` de uma instância há 1 minuto.

**Impacto.** Com as outras instâncias no ar, não há perda: mensagens em andamento na instância caída voltam à fila pelo visibility timeout e são processadas por outra. HTTP depende do balanceador remover a instância.

**Investigação.** `docker compose ps` e `docker compose logs <instância>`. Veja se o container reiniciou (OOM, crash na inicialização, migration pendente) ou se é só rede.

**Mitigação.** `docker compose up -d <instância>`. O serviço é stateless; reiniciar é seguro a qualquer momento.

---

## WagerLatencyHigh

**Severidade:** warning

**Significado.** O p99 do processamento de transações passou de 1 segundo nos últimos 5 minutos.

**Impacto.** Provedores podem atingir timeout e reenviar (o que é seguro, por idempotência, mas aumenta a carga).

**Investigação.**

1. Grafana: a latência subiu junto com a espera do lock (`Wallet lock wait`)? Então é contenção em wallets quentes.
2. Jaeger: abra um trace lento e veja qual span domina (`wallet.lock`, `db.transaction`).
3. Banco: conexões esgotadas, queries lentas, autovacuum.

**Mitigação.** Contenção numa wallet é limitada por design ([ADR 0004](../adr/0004-serialize-wallet-operations-with-pessimistic-row-locks.md)). Para carga geral, adicione instâncias ou recursos ao banco.

---

## WalletLockContention

**Severidade:** warning

**Significado.** O p95 da espera pelo lock da wallet (`SELECT ... FOR UPDATE`) passou de 500 ms.

**Impacto.** Muitas operações simultâneas na mesma wallet estão sendo serializadas, o que é o comportamento esperado, mas a fila está longa.

**Investigação.** Encontre as wallets mais disputadas:

```sql
SELECT wallet_id, count(*) FROM wager_transactions
 WHERE created_at > now() - interval '5 minutes'
 GROUP BY wallet_id ORDER BY count(*) DESC LIMIT 10;
```

Um volume anormal numa única wallet pode indicar um provedor em loop de retry ou abuso.

**Mitigação.** Contate o provedor se for retry em loop. Se for um padrão legítimo, a evolução é particionar a wallet (sub-saldos), registrada como limitação na [ARCHITECTURE.md](../../ARCHITECTURE.md).

---

## RejectionRateHigh

**Severidade:** warning

**Significado.** Mais de 20% das transações foram rejeitadas por regra de negócio nos últimos 10 minutos.

**Impacto.** Rejeições são resultados válidos (o dinheiro está correto), mas um pico sustentado costuma indicar um problema de integração de um provedor.

**Investigação.** No Prometheus, veja o canal e o tipo de transação:

```promql
sum by (channel, kind) (rate(wager_transactions_total{status="REJECTED"}[5m]))
```

O motivo e o provedor estão no banco (e nos logs `wager transaction settled`, campos `failureCode` e `providerId`):

```sql
SELECT provider_id, failure_code, count(*) FROM wager_transactions
 WHERE status = 'REJECTED' AND created_at > now() - interval '15 minutes'
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

`INSUFFICIENT_FUNDS` em massa sugere jogo ou bot; `REFERENCE_*` ou `CURRENCY_MISMATCH` sugerem bug no provedor.

**Mitigação.** Acione o provedor com os `failureCode` e exemplos de `externalTransactionId`.
