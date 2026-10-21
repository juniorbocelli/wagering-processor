# ADR-007 — Taxonomia fechada de `failureCode` e separação entre rejeição persistida e erro de contrato

- **Status:** Aceita
- **Data:** 2026-10-21
- **Relacionados:** ADR-003, ADR-004
- **Edital:** §6.3, §7, §9 (Status HTTP), §10, §11, §14 (Correção financeira — 20 pts; Idempotência — 15 pts; Mensageria e falhas — 15 pts)

---

## Contexto

O edital exige que transações rejeitadas registrem um `failureCode` (§6.3), que o mesmo
resultado seja devolvido em replays (§9) e que erros de negócio, transitórios e
permanentes sejam tratados de forma distinta no consumidor SQS (§10). Os eventos
`WagerTransactionRejected` (§11) carregam esse código para sistemas downstream.

Forças:

1. **Contrato público e estável.** Provedores automatizam decisões (reenviar, corrigir,
   escalar) a partir do código; renomear um código quebra integrações.
2. **Replay fiel.** O código persistido precisa ser exatamente o devolvido no primeiro
   processamento, inclusive anos depois (ADR-003 §4).
3. **Duas naturezas de falha.** Algumas falhas pertencem a uma transação que existe e é
   persistida (`REJECTED`/`FAILED`); outras são erros de contrato da requisição que **não**
   produzem transação (payload inválido, wallet inexistente, conflito de idempotência).
   Misturá-las faria o replay de um payload inválido parecer uma rejeição de negócio.
4. **Ordem de avaliação.** Uma transação pode violar mais de uma regra (ex.: moeda
   divergente **e** saldo insuficiente). O código precisa ser determinístico.
5. **§5.9:** valores livres em uma coluna `VARCHAR` permitem que um bug grave um código
   inexistente sem que ninguém perceba.

## Decisão

### 1. Dois vocabulários distintos

| Vocabulário | Onde aparece | Persistido? | Exemplos |
|---|---|---|---|
| **`failureCode`** (domínio) | `wager_transactions.failure_code`, resposta `422`, evento `WagerTransactionRejected` | Sim | `INSUFFICIENT_FUNDS` |
| **`code`** de erro de contrato (aplicação) | corpo de `400/404/409/503`, atributo `errorCode` na DLQ | Não | `VALIDATION_ERROR` |

### 2. Catálogo fechado de `failureCode`

| Código | Status | Quando | Provedor deve |
|---|---|---|---|
| `WALLET_PLAYER_MISMATCH` | `REJECTED` | `playerId` ≠ dono da wallet | corrigir payload |
| `CURRENCY_MISMATCH` | `REJECTED` | moeda ≠ moeda da wallet | corrigir payload |
| `REFERENCE_SCOPE_MISMATCH` | `REJECTED` | referência de outro provider/player/wallet/moeda/rodada | corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | `REJECTED` | `REFUND` de não-`BET`; `ROLLBACK` de `LOSS`/`ROLLBACK`/`OPENING`; `WIN` referenciando não-`BET` | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | `REJECTED` | referência existe, mas não está `PROCESSED` | investigar |
| `REFERENCE_ALREADY_REVERSED` | `REJECTED` | referência já revertida por `REFUND` ou `ROLLBACK` | não reenviar |
| `AMOUNT_MISMATCH` | `REJECTED` | valor ≠ valor da referência (§7.5) | corrigir payload |
| `INSUFFICIENT_FUNDS` | `REJECTED` | débito maior que o saldo | não reenviar igual |
| `REVERSAL_INSUFFICIENT_FUNDS` | `REJECTED` | `ROLLBACK` de crédito deixaria saldo negativo (§7.9) | escalar operacionalmente |
| `REFERENCE_NOT_FOUND` | `REJECTED` | referência não chegou dentro do limite (§7.1; política no futuro ADR-008) | investigar |
| `PROCESSING_FAILED` | `FAILED` | erro permanente não-negocial sobre transação já persistida (ex.: reprocessamento de `PENDING_REFERENCE` com dado irrecuperável) | escalar operacionalmente |

A ordem da tabela é a **ordem de avaliação** no use case: identidade (player, moeda) →
referência (escopo, tipo, estado, reversão, valor) → saldo. A primeira regra violada
define o código; as demais não são avaliadas.

### 3. Catálogo de `code` de contrato (não persistido)

| `code` | HTTP | SQS |
|---|---|---|
| `VALIDATION_ERROR` | 400 | DLQ (permanente) |
| `WALLET_NOT_FOUND` | 404 | DLQ (permanente) |
| `WALLET_ALREADY_EXISTS` | 409 | — |
| `IDEMPOTENCY_KEY_REUSED` | 409 | DLQ (permanente) |
| `EXTERNAL_TRANSACTION_ID_REUSED` | 409 | DLQ (permanente) |
| `INBOX_PAYLOAD_MISMATCH` | — | DLQ (permanente) |
| `TRANSIENT_FAILURE` | 503 + `Retry-After` | retry com backoff (transitório) |

### 4. Garantias

- **Domínio:** `FailureCode` é uma união literal TypeScript (`as const`) com o catálogo
  acima; `WagerTransaction.reject(code)` só aceita esses valores.
- **Banco (§5.9):** `CHECK (failure_code IN (...))` replicando o catálogo, além do já
  existente `CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL))`.
- **Evolução:** códigos são **aditivos**. Um código novo exige migration que amplia o
  `CHECK` e atualização deste ADR; códigos nunca são renomeados nem reaproveitados com
  outro significado. Remover um código é proibido enquanto houver linhas com ele.

### Alternativas consideradas

| Alternativa | Avaliação |
|---|---|
| Mensagem de erro livre (texto) | Rejeitada: não é legível por máquina e muda com refatorações. |
| Código numérico | Rejeitada: opaco em logs e eventos; exige tabela de consulta. |
| Persistir também erros de contrato como `REJECTED` | Rejeitada: payload inválido não tem wallet/valor confiáveis; wallet inexistente violaria a FK; poluiria replays. |
| Tabela de domínio (`failure_codes`) com FK | Viável, mas acrescenta join e seed sem ganho sobre o `CHECK` para um catálogo pequeno e versionado em migration. |
| Enum nativo do PostgreSQL | Rejeitada: `ALTER TYPE ... ADD VALUE` tem restrições transacionais e não remove valores; o `CHECK` é mais simples de versionar. |

## Consequências e Trade-offs

### Ganhos

- Contrato estável para provedores e consumidores de eventos.
- Replay devolve exatamente o mesmo código (persistido e validado pelo banco).
- Classificação do consumidor SQS (ADR-004 §3) deriva diretamente do vocabulário.
- Ordem de avaliação documentada torna o código determinístico e testável.

### Custos

- Todo código novo exige migration e atualização da documentação.
- Duplicação controlada do catálogo (TypeScript e `CHECK`); um teste de integração compara
  os dois para evitar divergência.

### Limitações conhecidas

- Um código por transação: violações secundárias não são reportadas.
- Os textos "Provedor deve" são orientação, não parte do contrato de máquina.
