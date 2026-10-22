# Teste de carga

<!-- results:start -->
## Ambiente

| Item | Valor |
|---|---|
| CPU | Intel(R) Core(TM) i5-7200U CPU @ 2.50GHz × 4 |
| RAM | 15.4 GiB |
| SO | linux x64 |
| Bun | 1.4.3 |
| PostgreSQL | 16.15 (`postgres:16-alpine`, contêiner) |
| LocalStack | `localstack/localstack:4.4` (contêiner) |
| Aplicação | 3 processos `bun src/main.ts`, pool de 20 conexões cada |
| Gerador de carga | mesmo host (disputa CPU com os processos acima) |
| Data | 2026-10-22T18:43:35.798Z |

## Metodologia

- Laço fechado: 64 clientes concorrentes, cada um envia a próxima requisição ao receber a resposta; HTTP em rodízio entre as instâncias.
- Aquecimento de 2 s (descartado) e janela fixa de 5 s por cenário.
- Mix: 70% BET, 20% WIN, 5% LOSS, 5% REFUND (de uma BET processada; sem BET disponível, vira BET). Valor fixo de 1.00 BRL e saldo inicial de 1.000.000,00 — o teste mede throughput e latência, não rejeições por saldo.
- Cada operação usa uma `Idempotency-Key` nova (não mede replays).
- Ao final de cada cenário: espera a outbox escoar e reconcilia todas as wallets via `POST /wallets/:id/reconciliation`.

## Resultados

### Distribuição uniforme

Wallets: 100 · janela medida: 5.0 s · requisições: 285

| Métrica | Valor |
|---|---|
| Throughput | **57 req/s** |
| Latência p50 / p95 / p99 | 1160.2 / 2183.4 / 2712.0 ms |
| Taxa de erro (5xx + transporte) | 0.00% |
| `wallet_lock_timeouts_total` (delta) | 0 |
| `outbox_lag_seconds` máximo observado | 5.5 s |
| Tempo para a outbox escoar após a carga | 1.6 s |
| Wallets que falharam na reconciliação | 0 |

| Status HTTP | Qtde | % |
|---|---|---|
| 201 | 285 | 100.00% |

| Operação | Qtde | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|
| BET | 201 | 1196.6 | 2185.8 | 2662.3 |
| WIN | 56 | 1049.1 | 2207.9 | 2791.2 |
| LOSS | 16 | 1190.6 | 1695.4 | 1695.4 |
| REFUND | 12 | 1001.8 | 1737.9 | 1737.9 |

### Hot wallet (80% das operações em uma wallet)

Wallets: 100 · janela medida: 5.0 s · requisições: 246

| Métrica | Valor |
|---|---|
| Throughput | **49 req/s** |
| Latência p50 / p95 / p99 | 1344.6 / 3029.0 / 3621.1 ms |
| Taxa de erro (5xx + transporte) | 0.00% |
| `wallet_lock_timeouts_total` (delta) | 0 |
| `outbox_lag_seconds` máximo observado | 1.6 s |
| Tempo para a outbox escoar após a carga | 1.3 s |
| Wallets que falharam na reconciliação | 0 |

| Status HTTP | Qtde | % |
|---|---|---|
| 201 | 246 | 100.00% |

| Operação | Qtde | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|---|
| BET | 186 | 1318.3 | 3029.0 | 3621.1 |
| WIN | 39 | 1541.1 | 3581.1 | 3816.8 |
| LOSS | 8 | 341.7 | 2640.0 | 2640.0 |
| REFUND | 13 | 1198.7 | 2643.2 | 2643.2 |

<!-- results:end -->

## Análise

> Os números acima são de **um notebook de 2 núcleos / 4 threads** (i5-7200U) que hospeda
> ao mesmo tempo o PostgreSQL, o LocalStack, as 3 instâncias da aplicação e o gerador de
> carga. Servem para comparar cenários entre si e para provar ausência de erros sob carga —
> **não** como capacidade do sistema em hardware dedicado. Não há meta de RPS.

- **Corretude sob carga:** 0% de erros 5xx/transporte, 0 `wallet_lock_timeouts_total`, a
  outbox escoou por completo e **todas** as wallets reconciliaram (saldo == ledger, corrente
  íntegra) nos dois cenários.
- **Gargalo no cenário uniforme:** com 64 clientes em laço fechado e p50 ≈ 730 ms, a Lei de
  Little já explica o throughput (64 / 0,73 s ≈ 88 req/s). Como as wallets são distintas, não
  há contenção de lock entre requisições; a latência vem de CPU saturada no host (7 processos
  disputando 4 threads) e das várias idas ao banco por operação. *Hipótese não perfilada:* não
  medimos a divisão entre CPU da aplicação e do PostgreSQL.
- **Efeito da serialização por wallet (ADR-002):** com 80% das operações numa única wallet, o
  throughput caiu cerca de 20% e o p95 dobrou (≈ 1,3 s → ≈ 2,6 s), com p50 ≈ 945 ms. É o custo
  esperado do lock pessimista: as operações da wallet quente formam fila no PostgreSQL. O
  `lock_timeout` de 3 s não foi atingido (p99 ≈ 3,2 s inclui a fila *e* a CPU compartilhada,
  não só a espera pelo lock); em máquina mais lenta ou com mais clientes, esse cenário
  passaria a gerar `503` com `Retry-After`, que é o comportamento projetado.
- **Outbox:** o lag máximo amostrado (3,2 s no uniforme; 0,9 s no hot) é lido a cada 1 s em
  `/metrics`; o valor de 3,2 s ocorreu sob a CPU mais disputada da fase uniforme. Após o fim da
  carga não havia backlog (0 s para escoar). O publicador usa polling de 100 ms nos testes.
- **Limites do experimento:** laço fechado (não modela chegada independente de requisições),
  uma única execução por cenário (sem intervalo de confiança), sem replays e sem o caminho
  SQS. Reexecute com `bun run test:load` (parâmetros `LOAD_*` no cabeçalho de
  `test/load/run.ts`); a seção de resultados é regenerada e esta análise é preservada.
