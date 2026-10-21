# ADR-005 — Adoção do MikroORM (Unit of Work, Identity Map e transações gerenciadas)

- **Status:** Aceita
- **Data:** 2026-10-20
- **Revisão:** 2026-10-20 — versão alvo atualizada para MikroORM 7.x, migrations em lista explícita e FKs diferíveis, após análise comparativa com implementação de referência
- **Relacionados:** ADR-001, ADR-002, ADR-004
- **Edital:** §4 (ORM — MikroORM preferencial; justificar escolha, mapeamento do `Money` e estratégia transacional), §5.9, §6.0, §6.1, §14 (Modelagem e arquitetura — 10 pts)

---

## Contexto

O edital exige **um** ORM entre MikroORM (preferencial) e TypeORM, e pede justificativa
da escolha, do mapeamento do `Money` e da estratégia transacional.

Forças:

1. **Atomicidade de múltiplos agregados** (wallet, transação, ledger, inbox, outbox) numa
   única transação (ADR-004) — precisamos de um mecanismo explícito de fronteira
   transacional e de *flush* ordenado.
2. **Lock pessimista declarativo** (ADR-002).
3. **Domínio puro** (§6.0, §6.1): construtores privados, factories `create`/`rehydrate`,
   sem decorators de ORM/NestJS, sem tipos monetários do ORM. A reidratação deve passar
   por `rehydrate` (que não revalida transições).
4. **Constraints avançadas no schema** (CHECKs, índices parciais, triggers diferidos)
   — nenhum ORM gera isso a partir de metadata; migrations precisam aceitar SQL bruto e
   ser **reversíveis**.
5. **Runtime Bun**: decorators + `emitDecoratorMetadata` e descoberta por reflexão
   (`ts-morph`) são pontos historicamente frágeis fora do Node.
6. **Múltiplas instâncias / concorrência**: estado compartilhado de ORM entre requisições
   (contexto global) é fonte de bugs de Identity Map obsoleto.
7. Alinhamento com a stack interna da Jungle Gaming.

## Decisão

Adotamos **MikroORM 7.x** (linha estável atual) com `@mikro-orm/postgresql` e
`@mikro-orm/migrations`, nos seguintes termos:

### 1. Persistência separada do domínio via `EntitySchema`

- Modelos de persistência (`WalletRecord`, `WagerTransactionRecord`,
  `LedgerEntryRecord`, `InboxRecord`, `OutboxRecord`) definidos com **`EntitySchema`**
  em `src/infrastructure/persistence/mikro-orm/schemas` — **sem decorators** e sem
  dependência de reflexão de tipos (contorna o risco nº 5).
- **Mappers explícitos** convertem `Record ⇄ Domínio`:
  `Wallet.rehydrate({ ..., balance: Money.from({ amount: r.balanceAmount, currency: r.currency }) })`.
- Repositórios (adapters) implementam portas da camada de aplicação
  (`WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`,
  `InboxRepository`, `OutboxRepository`).

### 2. Mapeamento do `Money`

| Domínio | Coluna | Tipo MikroORM | Runtime |
|---|---|---|---|
| `Money.amount` | `*_amount NUMERIC(19,2)` | `decimal` (precision 19, scale 2) | **`string`** |
| `Money.currency` | `currency CHAR(3)` | `string` (length 3) | `string` |

Duas colunas, reidratadas como `Money` no mapper (§6.1 permite colunas separadas). O
`Record` nunca expõe `number` para valores monetários; o domínio nunca vê o `Record`.

### 3. Estratégia transacional (Unit of Work explícito)

```ts
// infrastructure/persistence/mikro-orm/mikro-orm-unit-of-work.ts
async run<T>(work: () => Promise<T>): Promise<T> {
  return this.em.fork().transactional(async (em) => {
    await em.execute(`SET LOCAL lock_timeout = '3s'`);
    return work();            // repositórios resolvem o EM transacional via contexto
  }, { isolationLevel: IsolationLevel.READ_COMMITTED });
}
```

- **`allowGlobalContext: false`**: qualquer uso do EM global falha imediatamente —
  cada requisição/mensagem/ciclo de worker usa um **fork** com Identity Map próprio.
- **`em.transactional()`**: abre a transação, registra o EM no contexto transacional
  (AsyncLocalStorage, suportado pelo Bun), faz **flush** ao final do callback e
  **commit**; qualquer exceção → rollback integral.
- **Identity Map**: garante uma única instância por linha dentro da unidade de trabalho;
  como o lock (`em.findOne(WalletRecord, id, { lockMode: LockMode.PESSIMISTIC_WRITE })`)
  é a **primeira** leitura da wallet no fork, não há estado obsoleto.
- **Unit of Work**: o flush ordena INSERTs por dependência de FK (transação → ledger) e
  agrupa as escritas num único round-trip por tabela.
- **`version`** é mapeado como coluna comum (não `version: true`), pois o edital define
  que ela só incrementa quando o **saldo** muda — regra do domínio. A atualização da
  wallet usa `UPDATE ... WHERE id = ? AND version = ?` com checagem de linhas afetadas
  (defesa secundária, ADR-002).
- Queries de concorrência que o ORM não expressa bem (`FOR UPDATE SKIP LOCKED` com
  `UPDATE ... RETURNING` da outbox, `INSERT ... ON CONFLICT DO NOTHING` da inbox) usam
  `em.getConnection().execute()` **dentro da mesma transação**.
- A camada de aplicação depende apenas da porta `UnitOfWork`, não do MikroORM.

### 4. Migrations versionadas e reversíveis

- `@mikro-orm/migrations` com classes `up()`/`down()` escritas **à mão em SQL**, pois
  CHECKs, índices parciais, triggers de imutabilidade e *constraint triggers* diferidos
  não são geráveis a partir de metadata.
- Migrations registradas numa **lista explícita** (`migrationsList`), sem descoberta por
  glob nem snapshot — comportamento idêntico no Bun, no container e nos testes.
- FKs `DEFERRABLE INITIALLY DEFERRED` (ADR-002 §2): o flush do Unit of Work pode ordenar os
  INSERTs livremente, inclusive com a auto-referência de `wager_transactions`.
- `schema:update`/`synchronize` **desabilitados**; o CI roda `up → down → up` para provar
  reversibilidade.

### Alternativas consideradas

| Alternativa | Avaliação |
|---|---|
| **TypeORM** | Aceito pelo edital. Rejeitado: `save()` mistura insert/update com semântica implícita, sem Identity Map/Unit of Work reais por requisição, histórico de bugs de transação com `EntityManager` compartilhado. |
| **Decorators MikroORM nas classes de domínio** | Rejeitado: viola §6.1 (domínio sem dependência de ORM) e o ORM hidrataria sem passar por `rehydrate`. |
| **`EntitySchema` apontando direto para classes de domínio** | Rejeitado: MikroORM hidrata via `Object.create` contornando `rehydrate`, e campos privados `_balance: Money` exigiriam *custom types* acoplando domínio e ORM. |
| **SQL puro (`pg`/`postgres.js`)** | Máximo controle, mas o edital avalia o uso do ORM e perderíamos UoW/Identity Map. |
| **Prisma** | Fora do escopo do edital. |

## Consequências e Trade-offs

### Ganhos

- **Fronteira transacional única e explícita**, alinhada ao ADR-004.
- **Domínio 100% puro**, testável sem banco; invariantes encapsuladas nas classes.
- **Lock pessimista declarativo** (`LockMode.PESSIMISTIC_WRITE`).
- Isolamento por fork elimina vazamento de estado entre requisições concorrentes.
- Independência de reflexão/decorators no caminho de persistência (robustez no Bun).

### Custos

- **Duplicação estrutural** Record ⇄ Domínio e mappers manuais (boilerplate, mais testes).
- Change tracking do ORM opera sobre os Records; o repositório precisa aplicar o estado
  do agregado ao Record antes do flush.
- Parte das queries críticas fica em SQL bruto (outbox/inbox), fora da abstração do ORM.
- Migrations manuais exigem disciplina para manter `EntitySchema` e DDL coerentes
  (mitigado por teste de integração que valida schema vs. metadata).

### Limitações conhecidas

- **Risco de compatibilidade Bun × MikroORM 7 / driver `pg`**: reduzido (há implementação
  de referência funcionando com MikroORM 7.x + NestJS 12 sobre Bun), mas ainda validado por
  *smoke test* de integração no Passo 2; se surgir bloqueio, o fallback documentado é
  TypeORM com `QueryRunner` explícito (novo ADR substituiria este).
- NestJS no Bun requer `emitDecoratorMetadata` para DI; mitigado por não usar
  `verbatimModuleSyntax` (evita apagar imports usados apenas como tipo em construtores).
