# ADR-002 — Concorrência confinada à `walletId` via lock pessimista no PostgreSQL

- **Status:** Aceita
- **Data:** 2026-10-20
- **Revisão:** 2026-10-20 — incorporada a verificação de corrente do ledger e FKs diferíveis após análise comparativa com implementação de referência (antes de qualquer código)
- **Revisão:** 2026-10-21 — trigger saldo ↔ ledger passa a cobrir `INSERT` (abertura com saldo) e exige `version` + 1; `statement_timeout` restrito a `SET LOCAL`; papéis de banco separados (antes de qualquer código)
- **Relacionados:** ADR-001, ADR-003, ADR-004, ADR-005
- **Edital:** §3, §5.6, §5.7, §5.8, §5.9, §6.2, §8, §13 (Concorrência 1–4), §14 (Concorrência — 20 pts; eliminatórias "saldo negativo por race", "débito/crédito duplicado", "correta somente com uma instância")

---

## Contexto

A **unidade de concorrência é a `walletId`** (§8). O sistema roda em **≥ 3 instâncias**,
recebendo a mesma wallet por HTTP e por SQS simultaneamente. O cenário obrigatório:
saldo `100.00`, duas apostas de `80.00` em paralelo → exatamente uma `PROCESSED`, uma
`REJECTED`, saldo `20.00`, um único `DEBIT`.

Forças e riscos:

1. **Lost update.** O padrão ingênuo `read → calculate → update` (proibido em §5.7)
   permite que duas transações leiam `100.00`, ambas debitem `80.00` e gravem `20.00`
   — saldo final errado e **dois** lançamentos de débito.
2. **Coordenação em memória não funciona com N processos.** Mutex/semáforo por wallet
   dentro do Node/Bun protege apenas a própria instância (§5.8).
3. **Lock global é proibido** (§5.6) e mataria o paralelismo entre wallets distintas.
4. **Hot wallet.** Testes disparam 50 requisições paralelas na mesma wallet. Estratégias
   otimistas degeneram em *retry storm* exatamente nesse caso.
5. **Seção crítica é maior que o UPDATE do saldo.** Dentro dela precisamos: checar
   idempotência, resolver a referência (REFUND/ROLLBACK), validar unicidade da reversão,
   calcular `balanceBefore`/`balanceAfter`, gravar ledger, inbox e outbox.
6. **Processos morrem segurando recursos.** Um lock não pode sobreviver ao processo
   que o adquiriu.
7. **Identity Map do ORM** (ADR-005) pode reter uma versão obsoleta da wallet se ela for
   carregada *antes* do lock.

## Decisão

### 1. Lock pessimista de linha na `wallets`, primeira leitura da transação

Toda operação que altera (ou decide sobre) o saldo executa, dentro de uma única
transação `READ COMMITTED`:

```sql
SET LOCAL lock_timeout = '3s';
SELECT * FROM wallets WHERE id = $1 FOR UPDATE;   -- MikroORM: LockMode.PESSIMISTIC_WRITE
```

- O lock é **por linha** → wallets distintas processam em paralelo sem contenção.
- Transações concorrentes da mesma wallet **enfileiram no PostgreSQL**; ao obter o lock,
  `READ COMMITTED` garante que o `FOR UPDATE` devolve a **última versão confirmada** e
  que cada statement subsequente vê os commits anteriores (inclusive a transação
  concorrente que acabou de gravar a mesma idempotency key).
- O lock é liberado no `COMMIT`/`ROLLBACK`. Se o processo morre, o PostgreSQL detecta
  a queda da conexão e aborta a transação — **nenhum lock órfão**.
- O carregamento com lock é **a primeira leitura da wallet** num `EntityManager`
  recém-forkado (ver ADR-005), eliminando estado obsoleto do Identity Map.

```mermaid
sequenceDiagram
  participant A as Instância A (BET 80)
  participant B as Instância B (BET 80)
  participant PG as PostgreSQL
  A->>PG: BEGIN; SELECT wallet FOR UPDATE
  PG-->>A: balance=100.00 (lock adquirido)
  B->>PG: BEGIN; SELECT wallet FOR UPDATE
  Note over B,PG: B bloqueia aguardando A
  A->>PG: INSERT tx, ledger DEBIT, outbox; UPDATE wallet=20.00 v+1
  A->>PG: COMMIT
  PG-->>B: balance=20.00 (versão confirmada)
  B->>PG: INSERT tx REJECTED(INSUFFICIENT_FUNDS), outbox
  B->>PG: COMMIT
```

### 2. Defesa em profundidade no schema (§5.9)

O lock é a estratégia primária; o schema garante que, **mesmo que o código erre**, a
invariante não é violada — a transação falha em vez de corromper dados:

| Garantia | Mecanismo no banco |
|---|---|
| Saldo nunca negativo | `CHECK (balance_amount >= 0)` em `wallets`; `CHECK (balance_after >= 0)` no ledger |
| Sem lost update na cadeia do ledger | `wallet_ledger_entries.wallet_version` + `UNIQUE (wallet_id, wallet_version)`: duas transações que partissem da mesma versão colidiriam |
| **Continuidade da corrente** | trigger `BEFORE INSERT ledger_assert_chain`: lê o último lançamento da wallet (via índice `(wallet_id, wallet_version)`) e exige `NEW.wallet_version = último + 1` **e** `NEW.balance_before = último.balance_after`; sem lançamento anterior, exige `balance_before = 0` e `wallet_version ∈ {1, 2}` (wallet aberta com ou sem saldo inicial) |
| Aritmética do lançamento | `CHECK` de `balance_after = balance_before ± amount` conforme `direction` |
| Saldo ↔ ledger | *constraint trigger* `AFTER INSERT OR UPDATE ON wallets`, `DEFERRABLE INITIALLY DEFERRED`. **INSERT:** `version = 1`; se `balance_amount > 0`, exige no commit o lançamento `wallet_version = 1` com `balance_after = balance_amount`. **UPDATE:** se o saldo mudou, exige `NEW.version = OLD.version + 1` e o lançamento `wallet_version = NEW.version` com `balance_after = NEW.balance_amount`; se não mudou, exige `NEW.version = OLD.version` |
| Atualização condicionada | `UPDATE wallets SET ..., version = version + 1 WHERE id = $1 AND version = $2` com verificação de *affected rows = 1* |
| No máximo um lançamento por transação | `UNIQUE (transaction_id)` no ledger |

As três primeiras linhas de "cadeia" são complementares: o `UNIQUE` barra duas escritas
concorrentes sobre a mesma versão; o trigger de corrente barra um lançamento
aritmeticamente válido que parte do **saldo anterior errado** (ex.: `before=50` quando o
correto é `100`, `DEBIT 30`, `after=20` — passaria no `CHECK` e no trigger diferido, e
`50.00` sumiriam); o trigger diferido amarra o saldo materializado ao último lançamento.

Todas as FKs são `DEFERRABLE INITIALLY DEFERRED`, para que o flush do Unit of Work
(ADR-005) ordene INSERTs livremente — inclusive a auto-referência
`wager_transactions.reference_transaction_id`. Constraints `UNIQUE` permanecem **não**
diferíveis (são alvo de `ON CONFLICT` e devem falhar no statement).

**Semântica de `version` × ledger.** Uma wallet aberta com saldo zero nasce com
`version = 1` e **sem** lançamento; seu primeiro lançamento terá `wallet_version = 2`.
Aberta com saldo, o lançamento `OPENING` tem `wallet_version = 1`. Em ambos os casos vale
`wallet.version = coalesce(último wallet_version, 1)` e, com ledger vazio, saldo = 0 —
é essa a regra usada pela reconciliação (ADR-012) e pelos testes. Qualquer sequência de
lançamentos continua obrigada a respeitar a corrente (trigger de `INSERT` no ledger) e a
terminar no saldo materializado (trigger diferido), portanto `saldo = Σ ledger` vale nos
dois casos.

**Papéis de banco.** Triggers e `REVOKE` só protegem se a aplicação **não** for dona das
tabelas nem superusuário. Dois papéis:

| Papel | Uso | Privilégios |
|---|---|---|
| `wagering_owner` | migrations (Migrator, task avulsa) | dono do schema e das tabelas |
| `wagering_app` | API, consumer e workers | `SELECT, INSERT` em todas as tabelas; `UPDATE` em `wallets`, `wager_transactions`, `outbox_messages`; `DELETE` só em `inbox_messages`/`outbox_messages` (retenção, ADR-011); **sem** `UPDATE/DELETE/TRUNCATE` no ledger e sem DDL |

O script de inicialização do Postgres no Compose cria os dois papéis; na AWS (RDS), a
mesma separação vem do provisionamento.

### 3. Timeouts e proteção operacional

| Parâmetro | Valor | Efeito |
|---|---|---|
| `lock_timeout` (`SET LOCAL`) | 3 s | Espera máxima pelo lock da wallet → erro `55P03` mapeado como **transitório** (HTTP 503 + `Retry-After`; SQS retry) |
| `statement_timeout` (`SET LOCAL`) | 5 s | Corta queries patológicas **apenas nas transações financeiras**; não é configurado no servidor, para não afetar migrations nem a varredura de reconciliação (ADR-012) |
| `idle_in_transaction_session_timeout` | 10 s | Libera locks de um processo **travado** (não morto) que abriu transação e parou |
| Retry interno do use case | até 3×, backoff com jitter | Apenas para `40P01` (deadlock) e `40001` (serialização) — esperados como raríssimos |

A espera pelo lock é medida (`wallet_lock_wait_seconds`, histograma) e timeouts contados
(`wallet_lock_timeouts_total`), com alerta de contenção.

**Ordenação de locks:** cada transação de negócio trava **exatamente uma wallet**
(referências de REFUND/ROLLBACK pertencem à mesma wallet por regra §7.2), então não
há ciclo de espera entre wallets. Na entrada por SQS, o insert da inbox precede o lock
da wallet de forma consistente em todos os caminhos.

### 4. Pool de conexões

Um waiter de lock ocupa uma conexão. Dimensionamento: `instâncias × pool ≤
max_connections − reserva` (default: 3 × 10 ≤ 100 − 10). A fila excedente aguarda no
pool da aplicação (com `acquireTimeout`), não no banco.

### Alternativas consideradas

| Alternativa | Avaliação |
|---|---|
| **Mutex/semáforo em memória** | Rejeitada: correto apenas em uma instância (§5.8, eliminatório). |
| **Lock distribuído (Redis/Redlock)** | Rejeitada: novo componente crítico, falhas de relógio/lease, e o banco continuaria precisando garantir as invariantes. |
| **Optimistic locking (`version`) com retry** | Rejeitada como primária: em hot wallet com 50 concorrentes, a maioria falha e re-tenta; com retry limitado produz falhas espúrias, com retry ilimitado produz latência imprevisível. Mantida como **verificação secundária** no `UPDATE ... WHERE version = $2`. |
| **`UPDATE ... SET balance = balance - x WHERE balance >= x RETURNING`** | Excelente para débito isolado, mas a seção crítica inclui idempotência, resolução de referência e unicidade de reversão; seria preciso compor vários statements condicionais e ainda serializar o restante. Complexidade maior para o mesmo resultado. |
| **`pg_advisory_xact_lock(hash(walletId))`** | Viável e não global, mas colisões de hash causam *false sharing* entre wallets, e o lock não está atrelado à linha que protege. O lock de linha é mais explícito e auditável. |
| **`SERIALIZABLE`** | Correto, porém transfere a contenção para abortos `40001` em massa na hot wallet — mesmo problema do otimista. |
| **`FOR UPDATE NOWAIT` / `SKIP LOCKED`** | Inadequados aqui: queremos **esperar** a vez, não falhar nem pular. (`SKIP LOCKED` é usado nos *workers*, ADR-004.) |
| **Ordenação apenas pelo SQS FIFO (`MessageGroupId = walletId`)** | Proibido como garantia (§5.3, §8): HTTP não passa pela fila, e redelivery/visibility timeout quebram a exclusão mútua. Mantido como **otimização** que reduz contenção. |

## Consequências e Trade-offs

### Ganhos

- **Correção sob N instâncias por construção**: a exclusão mútua é do PostgreSQL, a
  fonte da verdade, e vale para HTTP, SQS e workers igualmente.
- **Comportamento previsível na hot wallet**: fila FIFO-like no banco, sem retry storm;
  o cenário 100/80/80 é determinístico (uma aceita, outra rejeitada por saldo).
- **Paralelismo total entre wallets distintas**.
- **Falha segura**: se o código tiver um bug, constraints e o trigger diferido abortam a
  transação em vez de persistir saldo incorreto.
- Raciocínio simples para revisão e apresentação: "uma wallet, um lock, uma transação".

### Custos

- **Throughput por wallet é serial**: limitado a ~1 / (duração da transação). Com
  transações de poucos ms, isso é centenas de operações/s por wallet — suficiente para
  um jogador, mas será medido no teste de carga (Passo 6).
- Conexões ocupadas por waiters reduzem a capacidade efetiva do pool sob contenção.
- Transações precisam ser **curtas**: nenhuma chamada de rede (SQS, IdP) dentro da
  seção crítica — publicação é delegada à outbox (ADR-004).
- O trigger diferido adiciona uma consulta indexada por commit que altera saldo.

### Limitações conhecidas

- Wallet extremamente quente (ex.: wallet "da casa" compartilhada) seria gargalo; a
  evolução seria particionar saldo (sub-contas) — fora de escopo.
- `lock_timeout` de 3 s sob carga extrema converte espera em erro transitório; o
  provedor/SQS precisa re-tentar (o que é seguro graças ao ADR-003).
