# ADR-008 — Política de referências fora de ordem

- **Status:** Aceita
- **Data:** 2026-10-22
- **Relacionados:** ADR-002, ADR-004, ADR-007
- **Edital:** §7.1, §10, §11, §14 (Mensageria e falhas)

---

## Contexto

Um `REFUND`, `CANCEL`, `WIN`-de-reversão ou qualquer operação que referencie outra por
`referenceExternalTransactionId` pode chegar **antes** da operação referenciada: filas e
provedores não garantem ordem entre mensagens de origens diferentes. Rejeitar de imediato
transformaria um atraso de entrega em perda de negócio; esperar para sempre prenderia
recursos e esconderia dados ruins.

Forças em disputa:

1. A transação pendente **não pode mover saldo** até a referência existir e estar processada.
2. A espera precisa ser **limitada** e observável.
3. Reprocessar não pode competir com o caminho de escrita nem consumir tentativas em dobro
   quando várias instâncias varrem o mesmo item.

## Decisão

### 1. Estado e política

A transação fica em `PENDING_REFERENCE` (persistida, com `reference_attempts` e
`next_reference_attempt_at`) e o evento `WagerTransactionPendingReference` é emitido pela
outbox. A política é única, injetável e tem estes padrões:

| Parâmetro | Valor |
|---|---|
| Atraso inicial | 1 s |
| Fator | 2× por tentativa |
| Teto do atraso | 60 s |
| Máximo de tentativas | 12 |
| TTL desde a criação | 15 min |

Esgotado o **limite de tentativas ou o TTL**, a transação vira `REJECTED` com
`REFERENCE_NOT_FOUND` (ADR-007) e emite `WagerTransactionRejected`. Referência que existe
mas não está processada segue a mesma espera e esgota em `REFERENCE_NOT_PROCESSED`.

### 2. Duas formas de resolução

- **Em cascata, na mesma transação:** ao processar uma operação, as dependentes pendentes
  **da mesma wallet** (que já está travada) são resolvidas na mesma transação. É o caminho
  comum e não gera latência extra.
- **Worker de varredura:** em **cada instância**, `PendingReferenceWorker` lista as
  transações vencidas (`next_reference_attempt_at <= now`) e chama
  `ReprocessPendingReferenceUseCase`, com até 5 reprocessamentos simultâneos.

### 3. Sem `SKIP LOCKED` na varredura (revisão do ADR-004 §5)

O desenho original previa `FOR UPDATE SKIP LOCKED` sobre `wager_transactions`. Isso foi
**descartado**: travar a linha da transação **antes** do lock da wallet inverte a ordem de
locks do caminho principal (wallet → transação) e abre um risco de deadlock.

Em vez disso:

1. a varredura é um `SELECT` simples (ordenado por vencimento) que apenas **sugere**
   candidatos;
2. o caso de uso relê a transação **sob o lock da wallet** e só tenta se ela ainda estiver
   `PENDING_REFERENCE` **e** vencida; caso contrário devolve `skipped` sem consumir tentativa.

Duas instâncias disputando o mesmo item serializam no lock da wallet; a segunda encontra o
item já resolvido (ou ainda não vencido) e desiste. A ordem de locks permanece uma só.

## Consequências e Trade-offs

### Ganhos

- Atraso de entrega não vira perda de negócio; a espera é limitada e visível por evento.
- Nenhuma coordenação entre instâncias e nenhuma nova ordem de locks.
- Tentativas consumidas **uma vez** por vencimento, mesmo com varreduras concorrentes.

### Custos

- Varreduras concorrentes podem listar o mesmo id; a segunda só paga uma leitura (e o lock
  da wallet, por instantes).
- `wager_transactions_total` conta a transação da própria requisição e os resultados do
  reprocessamento; resoluções em cascata dentro de uma transação não são contadas
  individualmente.

### Limitações conhecidas

- O TTL (15 min) é um padrão operacional, não um requisito do provedor; ajuste via política.
- Um provedor que reenvie a referência depois do prazo recebe a idempotência normal: a
  operação rejeitada permanece `REJECTED` e a nova tentativa exige nova `idempotencyKey`.
