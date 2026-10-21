# backend-challenge

Desafio Jungle Gaming para a vaga de Desenvolvedor Backend Sênior — processador
distribuído de transações de apostas.

Decisões de arquitetura: [`ARCHITECTURE.md`](ARCHITECTURE.md) e [`docs/adr/`](docs/adr/).

## Pré-requisitos

- Docker e Docker Compose v2
- [Bun](https://bun.sh) 1.4.3 (somente para rodar scripts e testes no host; a imagem
  Docker não depende dele)

## Início rápido

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run infra:up      # PostgreSQL 16 + LocalStack (SQS), com healthchecks
bun run typecheck && bun run lint && bun run test:unit
bun run infra:down    # derruba e remove volumes
```

`infra:up` cria os papéis `wagering_owner` (migrations) e `wagering_app` (runtime), os
bancos `wagering` e `wagering_test` e as filas FIFO `wager-transactions.fifo`,
`wager-transactions-dlq.fifo` e `wallet-events.fifo`.

## Scripts

| Script | Descrição |
|---|---|
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | ESLint + `check-money` (proíbe ponto flutuante no domínio) |
| `bun run test:unit` | testes unitários (sem infraestrutura) |
| `bun run test:integration` | testes contra PostgreSQL real (`wagering_test`); exige `infra:up` e aplica as migrations sozinho |
| `bun run migration:up` / `migration:down` | aplica todas as migrations pendentes / reverte a última (como `wagering_owner`) |
| `bun run migration:reset` / `migration:status` | reverte todas / lista as pendentes |
| `bun run infra:up` / `infra:down` | sobe / derruba a infraestrutura local |
