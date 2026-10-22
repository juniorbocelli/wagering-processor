# ADR-010 — Estratégia de testes multi-processo e injeção de falhas

- **Status:** Aceita
- **Data:** 2026-10-22
- **Relacionados:** ADR-002, ADR-003, ADR-004, ADR-008, ADR-012
- **Edital:** §5.8, §13 (Concorrência), §14 (Testes)

---

## Contexto

O edital exige correção com **múltiplas instâncias** e proíbe testes que substituam
PostgreSQL e SQS por mocks. Corridas entre processos, morte abrupta (`SIGKILL`) e reinício
só aparecem com processos reais: `Promise.all` dentro de um único processo compartilha pool,
event loop e memória, e não reproduz perda de lease, redelivery nem recuperação de outbox.

## Decisão

1. **Harness de cluster** (`test/support/cluster.ts`): cada instância é um processo
   `bun src/main.ts` — a mesma entrada da imagem Docker —, em porta livre, sobre o mesmo
   PostgreSQL e o mesmo LocalStack. O harness aguarda `/health/ready`, distribui requisições
   em *round-robin* e encerra com `SIGTERM` ou `SIGKILL`; pode reiniciar todas as instâncias.
2. **Largada sincronizada:** as requisições são criadas e só disparam quando uma barreira
   abre, maximizando a sobreposição. HTTP e SQS são usados no mesmo cenário quando o caso
   exige (ex.: a mesma `BET` 50× por HTTP nas 3 instâncias e por SQS).
3. **Isolamento sem truncar tabelas:** cada teste cria as próprias wallets (UUIDv7) e filas
   SQS exclusivas; as execuções são repetíveis e independentes da ordem.
4. **Injeção de falhas por ambiente:** `FAULT_INJECTION=<ponto>` ativa o `EnvFaultInjector`
   (somente testes; vazio em produção), que encerra o processo com `SIGKILL` no ponto
   escolhido — `crash_after_commit_before_ack` e `crash_after_publish_before_mark`. A morte é
   real: sem handlers, sem ack, sem liberar lease. A atomicidade intra-transação usa o ponto
   em-processo `after_ledger_insert`.
5. **Oráculo comum:** todo cenário termina com `wallet.balance == saldo reconstruído pelo
   ledger`, corrente contínua, `version` coerente e `POST /wallets/:id/reconciliation` com
   `consistent: true`.
6. **Cobertura dos 8 cenários do §13** (`test/concurrency/`):

   | # | Cenário | Arquivo |
   |---|---|---|
   | 1 | mesma `BET` 50× em paralelo (HTTP nas 3 instâncias + SQS) | `cluster-scenarios` |
   | 2 | saldo 100, duas `BET` de 80 (repetido 20×, instâncias distintas) | `cluster-scenarios` |
   | 3 | 200 wallets distintas, tempo ≪ serial (sem lock global) | `cluster-scenarios` |
   | 4 | hot wallet com 50 operações mistas | `cluster-scenarios` |
   | 5 | `SIGKILL` depois do commit e antes do ack | `crash-after-commit` |
   | 6 | publishers concorrentes sobre a mesma outbox | `cluster-scenarios` |
   | 7 | `REFUND` (HTTP) e `ROLLBACK` (SQS) antes da referência | `cluster-scenarios` |
   | 8 | `SIGKILL` das 3 instâncias no meio da carga + reinício | `restart-recovery` |

### Alternativas consideradas

| Alternativa | Avaliação |
|---|---|
| Concorrência só com `Promise.all` em um processo | Não prova o requisito de múltiplas instâncias; já existe como teste complementar (`initial-concurrency`) |
| Containers `app` via Compose nos testes | Mais fiel à implantação, porém lento e difícil de matar/reiniciar com precisão; o processo é o mesmo binário |
| Mocks de PostgreSQL/SQS | Proibido pelo edital (falha eliminatória) |
| Injeção de falhas por proxy de rede (toxiproxy) | Dependência extra; os pontos de falha relevantes são fronteiras de código conhecidas |

## Consequências e Trade-offs

### Ganhos

- Prova, com processos reais, as garantias de idempotência persistente, inbox, outbox e
  recuperação após crash.
- Falhas reproduzíveis no ponto exato, sem *sleeps* arbitrários para "acertar" a janela.

### Custos

- A suíte leva dezenas de segundos (boot de processos, visibility timeout reduzido a 5 s).
- Exige `infra:up` e portas livres; a suíte `http-health` pausa contêineres e não deve
  rodar em paralelo com ela.

### Limitações conhecidas

- O cenário 3 compara com uma linha de base serial medida na hora; em máquinas muito
  carregadas a razão pode oscilar (o limite de 60% tem folga ampla).
- Não há injeção de falha de rede entre aplicação e PostgreSQL além de pausa de contêiner
  (coberta nos testes de integração).
