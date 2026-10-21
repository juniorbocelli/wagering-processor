# ADR-012 — Reconciliação periódica que detecta e não corrige divergências

- **Status:** Aceita
- **Data:** 2026-10-20
- **Revisão:** 2026-10-21 — regra de versão corrigida para wallets abertas com saldo zero (antes de qualquer código)
- **Relacionados:** ADR-002, ADR-004
- **Edital:** §9 (Reconciliação), §12, §13 (invariante final), §14 (Correção financeira — 20 pts; Observabilidade — 5 pts)

---

## Contexto

O schema (ADR-002) torna divergência entre saldo materializado e ledger impossível em
qualquer escrita normal. Ainda assim, uma divergência pode surgir por intervenção manual
com triggers desabilitados, restore parcial, bug no próprio banco ou migration
defeituosa. O endpoint `POST /wallets/:walletId/reconciliation` (§9) só a encontra se
alguém consultar **aquela** wallet.

O edital exige que divergências **não** sejam corrigidas silenciosamente: devem ser
logadas, contabilizadas em métrica e sinalizadas.

Forças:

- Varredura completa não pode bloquear escritas nem abortar transações financeiras.
- Com N instâncias, varrer em todas triplica o trabalho sem ganho.
- O snapshot precisa ser consistente entre saldo e ledger durante toda a varredura.

## Decisão

- Um worker reconcilia **todas** as wallets a cada `RECONCILIATION_INTERVAL_MS`
  (padrão 5 min), usando o mesmo cálculo do endpoint:
  `Σ CREDIT − Σ DEBIT`, continuidade da corrente (`LAG(balance_after)`),
  `wallet.version = coalesce(último wallet_version, 1)` e, com ledger vazio, saldo = 0
  (wallet aberta com saldo zero não tem lançamento — ADR-002).
- A varredura roda numa **única transação `REPEATABLE READ READ ONLY`**, em lotes por
  keyset (`WHERE id > $último ORDER BY id LIMIT n`): todos os lotes enxergam o mesmo
  snapshot e nenhuma escrita é bloqueada.
- **Uma varredura por vez no cluster:** `pg_try_advisory_xact_lock(<constante>)` no início
  da transação; instâncias que não obtêm o lock pulam a rodada. O lock é liberado no fim
  da transação, inclusive se o processo morrer.
- Divergência ⇒ **detectar, nunca corrigir**: log `error` com `walletId` e diferença,
  métrica `wallet_reconciliation_divergent_wallets` (gauge) e
  `wallet_reconciliation_divergences_total`; `wallet_reconciliation_last_success_timestamp`
  permite alertar se o próprio worker parar.
- A correção, quando necessária, é decisão humana via lançamento de ajuste auditável
  (fora de escopo).

### Alternativas consideradas

| Alternativa | Avaliação |
|---|---|
| Corrigir o saldo automaticamente | Esconde o bug causador e reescreve histórico financeiro; proibido pelo edital. |
| Só reconciliação sob demanda | Divergência em wallet não consultada passa despercebida. |
| Todas as instâncias varrendo | Trabalho multiplicado sem ganho. |
| Lock de tabela ou `SERIALIZABLE` | Bloquearia ou abortaria escritas durante a varredura. |

## Consequências e Trade-offs

### Ganhos

- Divergência detectada em no máximo um intervalo, independentemente de consulta.
- Reforça a invariante final do §13 continuamente, não só nos testes.
- Reaproveita o caso de uso `ReconcileWallet`; custo de implementação baixo.

### Custos

- Snapshot `REPEATABLE READ` longo retém versões antigas de linhas (vacuum adiado)
  durante a varredura.
- Mais um worker e parâmetro de configuração.

### Limitações conhecidas

- Varredura linear no tamanho do ledger. Em escala, seria incremental (apenas wallets
  alteradas desde o último checkpoint) e partiria de saldos fechados por período.
