# ADR-013 — Contrato OpenAPI escrito à mão e verificado contra as rotas

- **Status:** Aceita
- **Data:** 2026-10-20
- **Relacionados:** ADR-003, ADR-006
- **Edital:** §9, §14 (Documentação — 5 pts)

---

## Contexto

Provedores integram pela API HTTP e precisam de um contrato navegável que descreva o que
decorators não capturam bem: semântica de idempotência, status HTTP por resultado de
negócio (ADR-003 §5), taxonomia de `failureCode` e exemplos.

No NestJS, o caminho comum é `@nestjs/swagger` com decorators. Porém os controllers
validam com `zod` e recebem `unknown`; decorators seriam uma **segunda descrição** do
mesmo contrato, espalhada pelo código e sem garantia de bater com a validação real.

## Decisão (proposta)

- Especificação **OpenAPI 3.1** versionada em `docs/api/openapi.yaml`, escrita à mão
  (*spec-first*), incluindo `Idempotency-Key`, todas as respostas por status,
  `failureCode` enumerados e exemplos.
- A aplicação serve a especificação em `/docs/openapi.json` e o Swagger UI em `/docs`
  (rotas públicas, como health).
- Teste unitário compara as rotas registradas no Nest com as da especificação **nos dois
  sentidos**, valida `operationId` únicos, `$ref` resolvíveis e a lista de `failureCode`
  contra o enum do domínio. O CI falha se divergirem.
- O lado assíncrono (fila de entrada e eventos) é documentado em `docs/api/messaging.md`.

### Alternativas consideradas

| Alternativa | Avaliação |
|---|---|
| `@nestjs/swagger` com decorators | Duplica os schemas zod e polui controllers. |
| Gerar OpenAPI a partir dos schemas zod | Bom para corpos, não cobre status, headers e semântica. |
| AsyncAPI para eventos | Padrão equivalente para mensageria; com 4 eventos, Markdown basta. |
| Não documentar contrato formal | Menor custo; perde pontos de Documentação e onboarding de provedores. |

## Consequências e Trade-offs

### Ganhos

- Contrato revisável em PR; rota não documentada quebra o CI.
- Documenta a semântica de reenvio que o provedor precisa para decidir retry.

### Custos

- Estimativa de 2–4 h; manutenção manual do YAML.
- O teste verifica existência de rotas, não cada campo dos schemas.

### Critério de promoção

Promovida a **Aceita**: contrato OpenAPI 3.1 entregue em `docs/api/openapi.yaml`, servido em `/docs` (Swagger UI) e `/docs/openapi.json` via `DocsController`, console operacional autoral em `/console` via `ConsoleController` e teste de paridade unitário em `test/unit/openapi-contract.test.ts`.
