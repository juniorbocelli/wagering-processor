# Runbook dos Alertas

Uma seção por alerta de `docker/observability/alerts.yml`; o `runbook_url` de cada alerta aponta para este documento. Cada seção descreve o significado, o impacto, a investigação e a mitigação recomendada.

Ferramentas usadas no ambiente Docker Compose:

```bash
docker compose --profile app logs -f app                      # logs JSON estruturados das réplicas
docker compose exec postgres psql -U wagering_owner wagering  # banco de dados
docker compose exec localstack awslocal sqs ...               # filas SQS no LocalStack
```

---

## WalletBalanceDivergence

**Severidade:** critical

**Significado.** A última reconciliação completa (`wallet_reconciliation_divergent_wallets`) encontrou carteiras cujo saldo armazenado (`balance_amount`), cadeia de versões (`chainIntact`) ou versão atual (`versionConsistent`) difere do ledger imutável (`wallet_ledger_entries`). Com os triggers de integridade ativos, isso só ocorre se um superusuário desabilitar triggers manualmente ou houver corrupção de armazenamento.

**Impacto.** O saldo da carteira diverge da trilha contábil. Novas movimentações nessa carteira tendem a ser barradas pelo trigger `trg_ledger_assert_chain` ou `trg_wallet_balance_has_ledger`.

**Investigação.**

1. Localize as carteiras no log de erro `wallet reconciliation divergence detected` (campos `walletId`, `difference`, `chainIntact`, `versionConsistent`).
2. Confirme via `POST /wallets/<walletId>/reconciliation`, que retorna `storedBalance`, `calculatedBalance`, `difference`, `chainIntact` e `versionConsistent`.
3. Inspecione o estado no banco:
   ```sql
   SELECT balance_amount, version, updated_at FROM wallets WHERE id = '<walletId>';
   SELECT wallet_version, direction, amount, balance_before, balance_after, created_at
     FROM wallet_ledger_entries WHERE wallet_id = '<walletId>' ORDER BY wallet_version DESC LIMIT 5;
   ```

**Mitigação.** **Nunca** sobrescreva o saldo silenciosamente ([ADR-012](../adr/0012-periodic-reconciliation-detect-not-correct.md)). A correção deve ser conduzida por auditoria operacional formal.

---

## ReconciliationStale

**Severidade:** warning

**Significado.** Nenhuma instância completou a varredura periódica (`wallet_reconciliation_last_success_timestamp`) nos últimos 30 minutos (o intervalo padrão `RECONCILIATION_INTERVAL_MS` é de 5 minutos).

**Impacto.** Eventuais divergências demorariam a ser detectadas. Não afeta o processamento de apostas em tempo real.

**Investigação.**

1. Procure nos logs por falhas do worker `periodic-reconciliation` (`worker cycle failed`).
2. Verifique se alguma sessão ficou presa segurando o advisory lock da reconciliação (chave `7040012`):
   ```sql
   SELECT pid, state, now() - xact_start AS duration, query
     FROM pg_stat_activity
    WHERE pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 7040012);
   ```

**Mitigação.** Se houver sessão órfã segurando o lock, encerre-a com `SELECT pg_terminate_backend(<pid>)`.

---

## OutboxLagHigh

**Severidade:** warning

**Significado.** O evento mais antigo ainda não publicado (`outbox_lag_seconds`) tem mais de 30 segundos por 2 minutos consecutivos.

**Impacto.** Consumidores da fila `wallet-events.fifo` recebem eventos com atraso. Os saldos e lançamentos no banco já estão confirmados.

**Investigação.**

1. Verifique logs do `outbox-publisher` (`outbox event publication failed; wallet is held behind it`).
2. Inspecione se uma carteira concentra os eventos retidos:
   ```sql
   SELECT aggregate_id, count(*), min(occurred_at)
     FROM outbox_messages WHERE published_at IS NULL
    GROUP BY aggregate_id ORDER BY count(*) DESC LIMIT 10;
   ```

**Mitigação.** Se for volume global, escale mais instâncias (`--scale app=N`). Eventos de carteiras independentes são drenados em paralelo via `FOR UPDATE OF o SKIP LOCKED`.

---

## OutboxStuck

**Severidade:** critical

**Significado.** Há eventos pendentes na outbox há mais de 5 minutos (`outbox_lag_seconds > 300`).

**Impacto.** Sistemas downstream (antifraude, relatórios externos) estão desatualizados para as carteiras afetadas.

**Investigação.**

1. Confira `GET /health/ready` para verificar se `sqs` está `down`.
2. Consulte `last_error` e `attempts` dos eventos mais antigos:
   ```sql
   SELECT id, aggregate_id, event_type, attempts, last_error, next_attempt_at
     FROM outbox_messages WHERE published_at IS NULL ORDER BY seq LIMIT 10;
   ```

**Mitigação.** Restabeleça a conectividade com o SQS. O `OutboxPublisherWorker` nunca descarta eventos e retomará a publicação automaticamente em ordem de `seq`.

---

## OutboxPublishFailures

**Severidade:** warning

**Significado.** Eventos na outbox estão cruzando o limiar de tentativas sem sucesso (`outbox_stuck_total`).

**Impacto.** A carteira do evento com falha fica retida atrás da cabeça para preservar a ordem causal ([ADR-004](../adr/0004-transactional-outbox-and-inbox.md)).

**Investigação.** Verifique a coluna `last_error` na tabela `outbox_messages` e as permissões/existência da fila `wallet-events.fifo`.

**Mitigação.** Corrija a infraestrutura SQS; os eventos serão reenviados automaticamente.

---

## DeadLetterQueueNotEmpty

**Severidade:** warning

**Significado.** O consumidor enviou mensagens com falha permanente para `wager-transactions-dlq.fifo` (`sqs_dlq_messages_total`).

**Impacto.** As mensagens rejeitadas por erro de contrato não foram aplicadas.

**Investigação.**

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names All --message-attribute-names All --max-number-of-messages 10
```

Inspecione os atributos `errorCode` (`VALIDATION_ERROR`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_TRANSACTION_ID_REUSED`, `INBOX_PAYLOAD_MISMATCH`), `errorMessage` e `sourceMessageId`.

**Mitigação.** Se for erro de payload do provedor, acione o provedor. Se a carteira foi criada posteriormente (`WALLET_NOT_FOUND`), a mensagem pode sofrer redrive com segurança, pois a inbox e a chave de idempotência protegem contra efeitos duplicados.

---

## SqsRetriesSpiking

**Severidade:** warning

**Significado.** Mais de uma mensagem por segundo está sofrendo falha transitória e voltando para a fila (`sqs_retries_total`).

**Impacto.** Aumento de latência no processamento assíncrono; após 5 tentativas (`maxReceiveCount = 5`), a redrive policy moverá a mensagem para a DLQ.

**Investigação.** Verifique logs `transient failure; message will be retried` e acompanhe `wallet_lock_timeouts_total` e a saúde do PostgreSQL.

**Mitigação.** Resolva a contenção ou indisponibilidade do banco. O backoff exponencial do consumidor reduz a pressão automaticamente.

---

## WageringInstanceDown

**Severidade:** critical

**Significado.** O Prometheus não consegue coletar `/metrics` de uma instância há mais de 1 minuto.

**Impacto.** As demais réplicas continuam atendendo HTTP, consumindo SQS e publicando a outbox (leases da instância morta expiram em `OUTBOX_LEASE_MS`).

**Investigação.** Verifique `docker compose ps` e `docker compose logs`.

**Mitigação.** Reinicie o contêiner afetado. A aplicação é stateless.

---

## WagerLatencyHigh

**Severidade:** warning

**Significado.** O p99 de `wager_processing_duration_seconds` ultrapassou 1 segundo nos últimos 5 minutos.

**Impacto.** Provedores com timeout curto podem reenviar requisições (absorvidas com segurança pela idempotência persistente).

**Investigação.** Compare com `wallet_lock_wait_seconds` para distinguir contenção em *hot wallet* de lentidão geral de I/O no PostgreSQL.

**Mitigação.** Ajuste o pool de conexões (`DB_POOL_MAX`) ou investigue *hot wallets*.

---

## WalletLockContention

**Severidade:** warning

**Significado.** O p95 do tempo de espera pelo lock de linha (`wallet_lock_wait_seconds`) ultrapassou 500 ms.

**Impacto.** Requisições concorrentes para uma mesma carteira estão enfileiradas no `SELECT ... FOR UPDATE`.

**Investigação.** Identifique as carteiras mais quentes:

```sql
SELECT wallet_id, count(*) FROM wager_transactions
 WHERE created_at > now() - interval '5 minutes'
 GROUP BY wallet_id ORDER BY count(*) DESC LIMIT 10;
```

**Mitigação.** Verifique se há loop indevido de retries no provedor para uma única carteira.

---

## RejectionRateHigh

**Severidade:** warning

**Significado.** Mais de 20% das transações liquidadas nos últimos 10 minutos terminaram em `status="REJECTED"`.

**Impacto.** Rejeições de negócio mantêm a contabilidade íntegra, mas um pico sustentado indica anomalia no provedor ou tentativa de abuso.

**Investigação.** Agrupe por `provider_id` e `failure_code`:

```sql
SELECT provider_id, failure_code, count(*) FROM wager_transactions
 WHERE status = 'REJECTED' AND created_at > now() - interval '15 minutes'
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

**Mitigação.** Notifique o provedor caso haja pico de `CURRENCY_MISMATCH`, `REFERENCE_SCOPE_MISMATCH` ou `AMOUNT_MISMATCH`.
