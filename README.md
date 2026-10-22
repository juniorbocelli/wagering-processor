# backend-challenge

Desafio Jungle Gaming para a vaga de Desenvolvedor Backend Sênior — processador
distribuído de transações de apostas (Bun · NestJS · PostgreSQL · SQS/LocalStack · MikroORM).

Decisões de arquitetura: [`ARCHITECTURE.md`](ARCHITECTURE.md) e [`docs/adr/`](docs/adr/).

## Pré-requisitos

- Docker e Docker Compose v2
- [Bun](https://bun.sh) 1.4.3 (somente para rodar scripts e testes no host; a imagem
  Docker não depende dele)

## Início rápido

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run infra:up        # PostgreSQL 16 + LocalStack (SQS), com healthchecks
bun run migration:up    # aplica o schema (como wagering_owner)
bun run start           # API + consumidor SQS + workers em http://localhost:3000
```

`infra:up` cria os papéis `wagering_owner` (migrations) e `wagering_app` (runtime), os
bancos `wagering` e `wagering_test` e as filas FIFO `wager-transactions.fifo`,
`wager-transactions-dlq.fifo` e `wallet-events.fifo`. `bun run infra:down` derruba tudo e
remove os volumes.

Exemplo de ponta a ponta:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"<id da wallet>","roundId":"round-1","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

### Rodando 3 instâncias

Todas as instâncias são idênticas (HTTP + consumidor SQS + workers) e se coordenam apenas
pelo PostgreSQL (locks por wallet, unicidade no schema, `SKIP LOCKED`, advisory lock).

```bash
# Via Docker Compose: cada réplica publica uma porta do host (3000, 3001, 3002…, até 10)
docker compose --profile app up -d --build --scale app=3

# Ou no host, três processos em portas distintas
PORT=3001 bun run start & PORT=3002 bun run start & PORT=3003 bun run start &
```

`SIGTERM`/`SIGINT` encerram de forma gradual: o HTTP para de aceitar conexões, o consumidor
conclui ou devolve (`visibility 0`) as mensagens em voo, os workers param e o pool fecha.

## API HTTP

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria wallet (`201`; `409 WALLET_ALREADY_EXISTS`; `400`) |
| `GET /wallets/:walletId` | saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor&limit` | ledger paginado (cursor opaco; `limit` 1–200, padrão 50) |
| `POST /wallets/:walletId/reconciliation` | recalcula o saldo pelo ledger; **detecta, nunca corrige** |
| `POST /wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET /health/live` · `GET /health/ready` | liveness · readiness (PostgreSQL e SQS) |
| `GET /metrics` | métricas Prometheus |

Valores monetários são sempre `{ "amount": "25.00", "currency": "BRL" }` (string decimal,
2 casas); um `amount` numérico é rejeitado com `400`. Campos desconhecidos também.

### Status HTTP (iguais em todos os endpoints)

| Situação | HTTP | Corpo | O provedor deve |
|---|---|---|---|
| Processada agora | `201` | `idempotentReplay: false` | — |
| Replay de processada | `200` | `idempotentReplay: true` | — |
| Rejeição de negócio (nova ou replay) | `422` | `status: REJECTED`, `failureCode` | não reenviar igual |
| Aceita, aguardando a referência | `202` | `status: PENDING_REFERENCE` | consultar depois |
| Falha permanente de infraestrutura | `500` | `status: FAILED`, `failureCode` | contatar o suporte |
| Conflito de idempotência | `409` | `code: IDEMPOTENCY_KEY_REUSED \| EXTERNAL_TRANSACTION_ID_REUSED` | corrigir key/payload |
| Payload inválido / header ausente | `400` | `code: VALIDATION_ERROR`, `violations[]` | corrigir payload |
| Wallet ou transação inexistente | `404` | `code: WALLET_NOT_FOUND \| TRANSACTION_NOT_FOUND` | corrigir referência |
| Falha transitória (lock, PG/SQS fora) | `503` + `Retry-After` | `code: TRANSIENT_FAILURE` | **reenviar com a mesma key** |

Erros seguem `{ "code", "message", "violations"?, "correlationId" }`. O `correlationId` vem
de `X-Correlation-Id` (se válido) ou é gerado (UUIDv7) e volta no header da resposta.
O catálogo de `failureCode` está em [ADR-007](docs/adr/0007-failure-code-taxonomy.md).

Autenticação: não implementada por decisão ([ADR-006](docs/adr/0006-decoupled-authentication.md));
o ponto de extensão é `ProviderIdentityPort` + `ProviderAuthGuard` (no-op). Health e
métricas são abertos.

## Variáveis de ambiente

Veja [`.env.example`](.env.example). As principais:

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | conexão do runtime (`wagering_app`) |
| `MIGRATION_DATABASE_URL` | — | conexão das migrations (`wagering_owner`) |
| `PORT` | `3000` | porta HTTP |
| `DB_POOL_MAX` | `20` | tamanho do pool |
| `AWS_ENDPOINT_URL` / `AWS_REGION` | LocalStack / `us-east-1` | SQS |
| `RECONCILIATION_INTERVAL_MS` | `300000` | varredura periódica de reconciliação |
| `LOG_LEVEL` | `info` | nível dos logs JSON |
| demais (`OUTBOX_*`, `RETENTION_*`, `SQS_*`, `SHUTDOWN_GRACE_MS`) | ver `.env.example` | mensageria e retenção |

## Scripts

| Script | Descrição |
|---|---|
| `bun run start` / `bun run dev` | sobe o serviço / com `--watch` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint |
| `bun run check:money` | proíbe ponto flutuante no domínio, na aplicação e nos mappers/DTOs |
| `bun run test:unit` (`bun run test`) | testes unitários (sem infraestrutura) |
| `bun run test:integration` | PostgreSQL e LocalStack reais; exige `infra:up`; aplica as migrations sozinho |
| `bun run test:concurrency` | os 8 cenários do §13 com 3 processos reais (`SIGKILL`, reinício); exige `infra:up` |
| `bun run test:load` | teste de carga (~1 min); regrava os resultados de `docs/load-test.md` |
| `bun run test:all` | unidade → integração → concorrência |
| `bun run migration:up` / `migration:down` | aplica as pendentes / reverte a última (como `wagering_owner`) |
| `bun run migration:reset` / `migration:status` | reverte todas / lista as pendentes |
| `bun run infra:up` / `infra:down` | sobe / derruba a infraestrutura local |

> Os testes de readiness (`test/integration/http-health.test.ts`) pausam por alguns
> segundos os contêineres `postgres` e `localstack` do compose (`docker compose pause`) e os
> retomam ao final — não rode outra coisa contra a infraestrutura durante essa suíte.

## Observabilidade

- Logs JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`,
  `providerId`; sem payloads financeiros.
- Métricas em `/metrics`: transações por status, replays e conflitos de idempotência,
  duplicatas de inbox, retries e DLQ do SQS, espera e timeout de lock, latência de
  processamento, `outbox_lag_seconds`, retenção e reconciliação
  (`wallet_reconciliation_divergences_total`, `wallet_reconciliation_divergent_wallets`,
  `wallet_reconciliation_last_success_timestamp`).
- Reconciliação: sob demanda (`POST /wallets/:id/reconciliation`) e periódica (todas as
  wallets, a cada 5 min, uma instância por vez via advisory lock).

## Resultados de carga

`bun run test:load` (3 instâncias, 64 clientes, 15 s medidos por cenário; notebook i5-7200U de
4 threads compartilhado com PostgreSQL, LocalStack e o gerador). Metodologia, ambiente e
análise completos em [`docs/load-test.md`](docs/load-test.md).

| Cenário | Throughput | p50 / p95 / p99 | Erros 5xx | Lock timeouts |
|---|---|---|---|---|
| Wallets uniformes | 85 req/s | 730 / 1327 / 1680 ms | 0% | 0 |
| Hot wallet (80% em uma) | 68 req/s | 945 / 2596 / 3176 ms | 0% | 0 |

Todas as wallets reconciliaram e a outbox escoou nos dois cenários. Os números refletem o
hardware modesto e compartilhado, não a capacidade do sistema.
