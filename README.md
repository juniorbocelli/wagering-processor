# wagering-processor

Desafio Jungle Gaming para a vaga de Desenvolvedor Backend Sênior — processador
distribuído de transações de apostas financeiras (`BET → WIN | LOSS | REFUND | ROLLBACK`)
com suporte a múltiplos provedores via **HTTP** e **SQS FIFO**, entrega **at-least-once**,
mensagens **fora de ordem** e concorrência real em **≥ 3 instâncias**.

Stack: **Bun** (1.4.3) · **NestJS** · **PostgreSQL 16** · **AWS SQS** (LocalStack) · **MikroORM** (7.x).

Documentação arquitetural detalhada: [`ARCHITECTURE.md`](ARCHITECTURE.md) e registros formais em [`docs/adr/`](docs/adr/).  
Contrato da API: [`docs/api/openapi.yaml`](docs/api/openapi.yaml) servido interativamente em `/docs` (Swagger UI) e `/docs/openapi.json`.  
Console Operacional Autoral: laboratório interativo com trilha em tempo real do ledger contábil em `/console`.  
Contrato de mensageria assíncrona: [`docs/api/messaging.md`](docs/api/messaging.md).

---

## Decisões de design e trade-offs

Para o detalhamento formal e alternativas rejeitadas, consulte as ADRs correspondentes:

- **Lock pessimista por wallet (`FOR UPDATE`) vs. lock otimista:** Em jogos de cassino com apostas em sequência rápida (modo turbo / *hot wallet*), dezenas de requisições chegam no mesmo segundo para a mesma carteira. O lock otimista (`WHERE version = ?`) faria a quase totalidade colidir, disparando tempestades de *retries*, latência alta e sobrecarga no banco. O lock por linha enfileira as requisições no próprio PostgreSQL sem custo de CPU e sem travar carteiras de outros jogadores. A coluna `version` foi mantida no schema como barreira secundária em profundidade ([ADR-002](docs/adr/0002-pessimistic-lock-per-wallet.md)).
- **PostgreSQL como única fonte da verdade (sem Redis):** Além da restrição do desafio (§5.2), o Redis não divide transação atômica com o PostgreSQL. Se uma chave fosse gravada no cache e o commit do banco falhasse em seguida, o sistema ficaria em estado inconsistente. A idempotência reside inteiramente no banco de dados com constraints `UNIQUE` e hash SHA-256 canônico ([ADR-003](docs/adr/0003-persistent-idempotency-canonical-hash.md)).
- **Dual-Write e ordenação causal (Transactional Outbox + Inbox):** Mensagens nunca são enviadas ao broker antes do commit da transação financeira. Eventos de saída e registros de inbox são gravados na mesma transação SQL que altera o saldo e gera o lançamento contábil. Na publicação, o worker trava apenas a "cabeça" da fila de cada carteira (`SKIP LOCKED`), garantindo ordem causal estrita por jogador sem bloquear a fila globalmente ([ADR-004](docs/adr/0004-transactional-outbox-and-inbox.md)).
- **Precisão monetária e baixa pressão no Garbage Collector (`bigint` em centavos):** O tipo `Money` armazena centavos em `bigint` nativo. Evitamos tanto o `number` (pelo clássico problema de ponto flutuante do IEEE 754) quanto bibliotecas de precisão arbitrária (`decimal.js`/`bignumber.js`), que criariam milhares de pequenos objetos na heap por segundo em alta carga. O `bigint` opera direto em instruções de inteiros de 64 bits da CPU ([ADR-001](docs/adr/0001-money-value-object.md)).
- **Reconciliação que audita sem alterar:** A reconciliação (sob demanda ou periódica via advisory lock) recalcula o saldo pelo somatório do ledger imutável. Adotamos o princípio de **detectar e alertar, nunca corrigir silenciosamente**, preservando a integridade contábil para auditoria humana ([ADR-012](docs/adr/0012-periodic-reconciliation-detect-not-correct.md)).

### Estrutura do projeto (Arquitetura Hexagonal / Ports & Adapters)

O código é estritamente separado em camadas concêntricas com regra de dependência unidirecional:

```text
src/
├── domain/         # Núcleo puro (TypeScript puro): Money, Wallet, WagerTransaction, Ledger.
│                   # Sem dependências externas, decorators de ORM ou bibliotecas HTTP.
├── application/    # Casos de uso e Portas (interfaces para UnitOfWork, repositórios, mensageria).
├── infrastructure/ # Adaptadores técnicos: MikroORM, PostgreSQL, SQS, Pino e Prometheus.
└── interfaces/     # Controladores HTTP NestJS, Consumidor SQS FIFO e Workers em background.
```

### Limitações conhecidas e premissas assumidas

- **Throughput serializado por carteira:** O lock de linha serializa as movimentações daquela carteira específica. Carteiras de jogadores operam em paralelo massivo, mas uma carteira compartilhada ("banca da casa") seria um gargalo intencional ([ADR-002](docs/adr/0002-pessimistic-lock-per-wallet.md)).
- **Escala monetária fixa em 2 casas decimais:** Atende com precisão moedas fiduciárias usuais (BRL, USD, EUR). Criptomoedas ou ativos fracionários exigiriam escala configurável por moeda ([ADR-001](docs/adr/0001-money-value-object.md)).
- **Janela de retenção finita:** Mensagens de inbox processadas são retidas por 7 dias e outbox publicada por 72 horas para conter o crescimento das tabelas; o histórico contábil permanente reside no `wallet_ledger_entries` ([ADR-011](docs/adr/0011-bounded-retention-inbox-outbox.md)).
- **Autenticação desacoplada:** Desenhada via porta `ProviderIdentityPort` com adaptador no-op para o desafio; autenticação real (ex.: OAuth2 Client Credentials via gateway) conecta-se sem alterar a aplicação ([ADR-006](docs/adr/0006-decoupled-authentication.md)).

---

## Início rápido

### Pré-requisitos

- Docker e Docker Compose v2
- [Bun](https://bun.sh) 1.4.3 (apenas para executar comandos e testes no host; a imagem de produção em contêiner não depende dele)

### Subindo o ambiente

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run infra:up        # PostgreSQL 16 + LocalStack (SQS), com healthchecks
bun run migration:up    # aplica o schema inicial e triggers de integridade
bun run start           # API + consumidor SQS + workers em http://localhost:3000
```

`infra:up` provisiona os papéis `wagering_owner` (migrations) e `wagering_app` (runtime de menor privilégio), os bancos `wagering` e `wagering_test` e as filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wallet-events.fifo`. `bun run infra:down` derruba tudo e remove os volumes.

### Exemplo de ponta a ponta

```bash
# 1. Cria uma carteira
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# 2. Submete uma aposta de R$ 25,00
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"<id da wallet retornada acima>","roundId":"round-1","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

### Console Operacional e Documentação Interativa

Para demonstrar visualmente e auditar o comportamento da aplicação em tempo real (sem depender de comandos `curl` manuais), a aplicação disponibiliza duas interfaces web públicas nativas:

1. **Console Operacional Autoral ([`http://localhost:3000/console`](http://localhost:3000/console))**:
   - **Propósito:** Uma bancada operacional interativa (*Operational Workbench*) desenvolvida especificamente para este projeto com design dark Jungle, focada na visualização transparente de invariantes contábeis e execução ao vivo.
   - **Monitoramento em Tempo Real:** Indicador de status de saúde contínuo checando a conectividade do PostgreSQL e SQS via `/health/ready`.
   - **Auditoria Visual do Ledger:** Inspeção em tempo real da trilha imutável do ledger append-only (direção de débito/crédito, progressão de `walletVersion`, `balanceBefore` e `balanceAfter`).
   - **4 Cenários Guiados em 1-Clique:**
     - ⚡ **1. Happy Path:** Abre uma carteira (R$ 100,00) e executa uma aposta (`BET`) de R$ 25,00 com sucesso (`HTTP 201`).
     - 🛡️ **2. Defesa Saldo Negativo:** Tenta debitar R$ 500,00 com saldo insuficiente, comprovando a blindagem contra saldo negativo e o retorno de negócio `INSUFFICIENT_FUNDS` (`HTTP 422`).
     - 🔁 **3. Idempotência Persistente:** Reenvia a transação idêntica com o mesmo payload e `Idempotency-Key`, demonstrando o replay consistente com `idempotentReplay: true` (`HTTP 200`) sem duplo débito.
     - ⚖️ **4. Auditoria Contábil:** Dispara a reconciliação formal (`POST /wallets/:walletId/reconciliation`) validando a integridade estrita da cadeia e do somatório (`chainIntact: true`, `versionConsistent: true`).
   - **Operação Manual Flexível:** Formulário para submeter qualquer tipo de operação (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), customizar valores em BRL e testar replays instantâneos.

2. **Swagger UI do Contrato OpenAPI 3.1 ([`http://localhost:3000/docs`](http://localhost:3000/docs))**:
   - Documentação interativa *spec-first* com schemas completos, parâmetros de header obrigatórios (`Idempotency-Key`, `X-Correlation-Id`), códigos de retorno detalhados e botão *Try it out*.
   - A especificação bruta pode ser consumida programaticamente em [`http://localhost:3000/docs/openapi.json`](http://localhost:3000/docs/openapi.json).

### Rodando em 3 instâncias concorrentes

Todas as instâncias da aplicação são stateless e idênticas (HTTP + consumidor SQS + workers). A coordenação distribuída é assegurada no PostgreSQL:

```bash
# Via Docker Compose: publica as portas 3000, 3001 e 3002
docker compose --profile app up -d --build --scale app=3

# Ou no host, rodando três processos simultâneos em portas distintas
PORT=3001 bun run start & PORT=3002 bun run start & PORT=3003 bun run start &
```

O encerramento via `SIGTERM`/`SIGINT` é gracioso: a API interrompe o aceite de novas requisições, o consumidor conclui ou devolve com `visibility 0` mensagens em trânsito, os workers finalizam o ciclo atual e o pool de conexões é liberado.

---

## Estratégia de testes e validação

O sistema conta com três níveis de testes automatizados com cobertura rigorosa:

| Suíte | Comando | Escopo e foco |
|---|---|---|
| **Unitários** | `bun run test:unit` | Domínio puro e regras contábeis em memória (280 testes sem I/O em < 2s). |
| **Propriedades (PBT)** | `bun run test:property` | Testes baseados em propriedades com `fast-check` (4.100+ asserções matemáticas de precisão monetária, comutatividade e invariantes de saldo). |
| **Integração** | `bun run test:integration` | PostgreSQL e SQS/LocalStack reais; aplica migrations e testa endpoints, concorrência no banco e filas. |
| **Concorrência & Falhas (§13)** | `bun run test:concurrency` | **Cobre os 8 cenários de concorrência e resiliência exigidos no desafio** rodando contra 3 processos de aplicação reais. |
| **Carga** | `bun run test:load` | Bateria de estresse com 64 clientes concorrentes (uniforme vs. hot wallet). |
| **Completo** | `bun run test:all` | Executa unidade → integração → concorrência em sequência determinística. |
| **Verificação Unificada** | `bun run check` | Pipeline completo (linter, types, regras monetárias, testes, promtool, docker, migrações, concorrência e build). Suporta `--quick`. |

> **Nota sobre integração e readiness:** A suíte `test/integration/http-health.test.ts` pausa temporariamente os contêineres `postgres` e `localstack` via `docker compose pause` para validar a resposta `503` do probe de readiness e os retoma ao final. Não execute comandos paralelos contra a infraestrutura durante essa execução.

### Os 8 Cenários de Concorrência e Tolerância a Falhas (§13 do edital)

A suíte `bun run test:concurrency` valida formalmente:
1. **Duas apostas simultâneas** com saldo suficiente para apenas uma (processamento determinístico e rejeição por saldo insuficiente sem race condition).
2. **Aposta e ganho simultâneos** na mesma carteira (saldo final aritmeticamente exato e ledger contínuo).
3. **Replay de idempotência simultâneo** ao processamento original (nenhum duplo débito; retorno fiel de resposta).
4. **50 requisições simultâneas em paralelo** com a mesma `Idempotency-Key` (exatamente 1 aplicada e 49 replays consistentes).
5. **Reversão (`ROLLBACK`) chegando antes da aposta (`BET`)** (transita para `PENDING_REFERENCE`, aguarda a aposta chegar e resolve com sucesso).
6. **Múltiplos workers disputando a fila SQS** (entrega at-least-once deduplicada via inbox atômico).
7. **Falha de rede durante o processamento** (`SIGKILL` no processo da aplicação no momento exato da escrita; reinício e recuperação sem duplicar lançamentos nem perder eventos).
8. **Reconciliação sob carga contínua** (auditoria contábil sem interferir nem travar as apostas concorrentes).

### Resultados do teste de carga

Medição executada com 3 instâncias da aplicação e 64 clientes concorrentes (detalhes em [`docs/load-test.md`](docs/load-test.md)):

| Cenário | Throughput | p50 / p95 / p99 | Erros 5xx | Lock timeouts |
|---|---|---|---|---|
| Wallets uniformes | 85 req/s | 730 / 1327 / 1680 ms | 0% | 0 |
| Hot wallet (80% em uma) | 68 req/s | 945 / 2596 / 3176 ms | 0% | 0 |

---

## API HTTP

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet (`201`; `409 WALLET_ALREADY_EXISTS`; `400`) |
| `GET /wallets/:walletId` | Consulta saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor&limit` | Consulta ledger paginado (cursor opaco; `limit` 1–200, padrão 50) |
| `POST /wallets/:walletId/reconciliation` | Recalcula o saldo pelo ledger; **detecta divergências, nunca altera dados** |
| `POST /wagering/transactions` | Submete transação financeira (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta transação por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta transação por id externo do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness · readiness (PostgreSQL e SQS) |
| `GET /metrics` | Métricas Prometheus |
| `GET /docs` | Documentação interativa Swagger UI do contrato OpenAPI 3.1 |
| `GET /docs/openapi.json` | Especificação OpenAPI 3.1 em formato JSON |
| `GET /console` | Console Operacional Autoral com auditoria contábil e cenários guiados em 1 clique |

Valores monetários são sempre trafegados como `{ "amount": "25.00", "currency": "BRL" }` (string decimal com 2 casas). Valores com tipo numérico `number` ou campos não mapeados são rejeitados com `400 Bad Request`.

### Mapeamento de Status HTTP

| Situação | HTTP | Corpo | Ação esperada do provedor |
|---|---|---|---|
| Processada agora | `201` | `idempotentReplay: false` | — |
| Replay de transação processada | `200` | `idempotentReplay: true` | — |
| Rejeição negocial (nova ou replay) | `422` | `status: REJECTED`, `failureCode` | Não reenviar com mesmos dados |
| Aceita aguardando referência | `202` | `status: PENDING_REFERENCE` | Consultar status posteriormente |
| Falha permanente de infraestrutura | `500` | `status: FAILED`, `failureCode` | Contatar o suporte operacional |
| Conflito de idempotência | `409` | `code: IDEMPOTENCY_KEY_REUSED \| EXTERNAL_TRANSACTION_ID_REUSED` | Corrigir chave ou payload |
| Payload inválido / header ausente | `400` | `code: VALIDATION_ERROR`, `violations[]` | Corrigir payload |
| Carteira ou transação inexistente | `404` | `code: WALLET_NOT_FOUND \| TRANSACTION_NOT_FOUND` | Corrigir identificador |
| Falha transitória (timeout/indisponibilidade) | `503` + `Retry-After` | `code: TRANSIENT_FAILURE` | **Reenviar com a mesma Idempotency-Key** |

Respostas de erro seguem o formato `{ "code", "message", "violations"?, "correlationId" }`. O `correlationId` é extraído do header `X-Correlation-Id` (quando válido) ou gerado como UUIDv7, sendo sempre devolvido no header HTTP da resposta. O catálogo completo de `failureCode` negociais está formalizado em [ADR-007](docs/adr/0007-failure-code-taxonomy.md).

---

## Observabilidade e Operação

- **Logs Estruturados (Pino):** Saída JSON padronizada com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Nenhum payload financeiro sensível é exposto em logs.
- **Métricas Prometheus (`/metrics`):** Contadores e histogramas para transações por status, replays e conflitos de idempotência, duplicatas de inbox, retries e DLQ do SQS, tempo de espera de lock, latência de processamento, `outbox_lag_seconds` e indicadores de divergência contábil (`wallet_reconciliation_divergences_total`).
- **Health Checks:** `/health/live` (saúde do processo) e `/health/ready` (validação ativa de conectividade com PostgreSQL e SQS com timeout de 2s).
- **Alertas Prometheus & Runbook Operacional:** 11 regras formais de alerta em [`docker/observability/alerts.yml`](docker/observability/alerts.yml) com testes automatizados via `promtool` em [`docker/observability/alerts.test.yml`](docker/observability/alerts.test.yml), cobrindo integridade contábil, latência p99, contenção de locks de wallet e lag de outbox. Cada alerta possui guia diagnóstico e mitigação no [Runbook de Alertas](docs/runbooks/alerts.md).
- **Auditoria Contábil Contínua:** Além do endpoint manual, um worker executa reconciliação periódica de todas as carteiras via transação `REPEATABLE READ` curta em batches com advisory lock no PostgreSQL.

---

## Scripts disponíveis

| Script | Descrição |
|---|---|
| `bun run start` / `bun run dev` | Inicia o serviço em modo produção / desenvolvimento com `--watch` |
| `bun run typecheck` | Checagem de tipos TypeScript estrita (`tsc --noEmit`) |
| `bun run lint` | Validação de estilo e qualidade de código com ESLint |
| `bun run check:money` | Scanner que proíbe ponto flutuante em arquivos de domínio e aplicação |
| `bun run test:property` | Executa a suíte de testes baseados em propriedades com `fast-check` |
| `bun run check` / `check --quick` | Executa a verificação unificada de sanidade local (completa ou rápida) |
| `bun run migration:up` / `migration:down` | Executa migrations pendentes / reverte a última (papel `wagering_owner`) |
| `bun run migration:reset` / `migration:status` | Reverte todas as migrations / exibe o status de execução |
| `bun run infra:up` / `infra:down` | Sobe / derruba a infraestrutura local em contêineres |

---

## Variáveis de ambiente

Consulte o arquivo [`.env.example`](.env.example) para a lista completa com valores padrão. Principais:

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | String de conexão do runtime (`wagering_app`) |
| `MIGRATION_DATABASE_URL` | — | Conexão para execução de migrations (`wagering_owner`) |
| `PORT` | `3000` | Porta de escuta da API HTTP |
| `DB_POOL_MAX` | `20` | Tamanho máximo do pool de conexões do banco |
| `AWS_ENDPOINT_URL` / `AWS_REGION` | LocalStack / `us-east-1` | Endpoint e região do AWS SQS |
| `RECONCILIATION_INTERVAL_MS` | `300000` | Intervalo da auditoria periódica de reconciliação (5 minutos) |
| `LOG_LEVEL` | `info` | Nível mínimo de emissão de logs (`trace`, `debug`, `info`, `warn`, `error`) |
