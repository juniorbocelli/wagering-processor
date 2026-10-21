# ADR-001 — Precisão monetária e imutabilidade via Value Object `Money`

- **Status:** Aceita
- **Data:** 2026-10-20
- **Decisores:** Engenharia (autor do desafio)
- **Relacionados:** ADR-002, ADR-003, ADR-005
- **Edital:** §5.1, §6.0, §6.1, §13 (Unidade), §14 (Correção financeira — 20 pts; falha eliminatória "`number` para dinheiro")

---

## Contexto

O serviço movimenta saldo de jogadores. Qualquer erro de representação numérica vira
**erro contábil** — e, no edital, usar `number` para dinheiro é **falha eliminatória**.

Forças em disputa:

1. **IEEE 754 é inexato para frações decimais.** `0.1 + 0.2 === 0.30000000000000004`.
   Somas repetidas de apostas acumulam deriva; comparações `balance >= amount` podem
   falhar por 1 ulp e permitir saldo "negativo invisível" ou rejeitar aposta válida.
2. **`JSON.parse` destrói precisão antes do nosso código executar.** Se o provedor
   envia `"amount": 25.10` (número JSON), o valor já chega como `number`. A única
   defesa é exigir **string** no contrato e rejeitar números.
3. **O driver `pg` devolve `NUMERIC` como `string`** por padrão (OID 1700). Basta alguém
   registrar um *type parser* com `parseFloat` para contaminar todo o sistema.
4. **Regras explícitas do edital (§6.1):** escala fixa de **2** casas; rejeitar `NaN`,
   `Infinity`, notação científica, string vazia, mais de 2 casas e negativos em
   contratos de entrada; operações entre moedas diferentes lançam erro de domínio;
   o domínio **não** depende de tipos do ORM nem de decorators do NestJS.
5. **Imutabilidade:** `Money` será compartilhado entre `Wallet`, `WalletLedgerEntry`,
   `WagerTransaction` e eventos. Mutação acidental de uma instância compartilhada
   corromperia `balanceBefore`/`balanceAfter` de um lançamento já criado.
6. **Operações necessárias são apenas aditivas** (`add`, `subtract`, `negate`,
   comparações). Não há multiplicação, divisão, juros ou rateio no escopo — portanto
   **não há arredondamento legítimo** em lugar nenhum do fluxo.

## Decisão

### 1. Representação interna: `bigint` em unidades menores (centavos)

`Money` encapsula um `bigint` com o valor em **unidades menores** (escala 2) e a moeda
ISO-4217. O esqueleto do edital usa `Decimal`; adaptamos o tipo interno (permitido
por §6: "nomes e assinaturas podem ser adaptados") mantendo a API pública.

```ts
export interface MoneyProps { amount: string; currency: string }

export class Money {
  private static readonly SCALE = 2n;
  private static readonly FACTOR = 100n;
  private static readonly INPUT = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;

  private constructor(
    private readonly minor: bigint,          // centavos, com sinal
    public readonly currency: CurrencyCode,
  ) { Object.freeze(this); }

  static from(props: MoneyProps): Money;     // contrato de entrada: >= 0, estrito
  static zero(currency: string): Money;

  add(o: Money): Money;  subtract(o: Money): Money;  negate(): Money;
  isZero(): boolean; isPositive(): boolean; isNegative(): boolean;
  isLessThan(o: Money): boolean; equals(o: Money): boolean;
  toJSON(): MoneyProps;  toString(): string; // sempre "1234.50"
  private assertSameCurrency(o: Money): void; // lança CurrencyMismatchError
}
```

- `bigint` é **exato e nativo** (sem dependência), e o TypeScript impede misturá-lo
  com `number` em operações aritméticas (`1n + 1` é erro de compilação).
- Valores negativos existem **apenas internamente** (ex.: `difference` da
  reconciliação, `negate()` de reversões). `Money.from` — usado em toda fronteira de
  entrada — **rejeita negativos**.

### 2. Gramática estrita de entrada

| Entrada | Resultado | Motivo |
|---|---|---|
| `"25"`, `"25.5"`, `"25.50"` | aceito → `"25.00"`, `"25.50"`, `"25.50"` | 0–2 casas, normalizado para escala 2 |
| `25.5` (number JSON) | **rejeitado** | precisão já perdida no `JSON.parse` |
| `""`, `" 1.00"`, `"1.00 "` | rejeitado | vazio / whitespace |
| `"NaN"`, `"Infinity"`, `"1e3"`, `"0x10"` | rejeitado | não-decimal / científica |
| `"-1.00"`, `"+1.00"` | rejeitado | sinal proibido no contrato de entrada |
| `"1.005"` | rejeitado | > 2 casas — **nunca arredondamos** |
| `"01.00"`, `"1."`, `".50"`, `"1,00"` | rejeitado | forma não canônica / ambígua |
| `"100000000000000000.00"` | rejeitado | > 17 dígitos inteiros (limite de `NUMERIC(19,2)`) |

Regex: `^(0|[1-9]\d{0,16})(\.\d{1,2})?$`. O limite de 17 dígitos inteiros garante que
nenhum valor aceito pelo domínio estoure a coluna no banco (overflow viraria erro de
infraestrutura em vez de erro de validação).

**Escala na entrada — padrão de mercado.** APIs de pagamento que usam string decimal
(ex.: PayPal Orders v2, `value: "25.00"`) aceitam **menos** casas que a escala da moeda e
rejeitam **mais**; a resposta é sempre canônica. Adotamos o mesmo princípio de robustez
("tolerante no que aceita, estrito no que emite"): `"25"` e `"25.5"` são aceitos e
normalizados; `"1.005"` é rejeitado; toda saída tem escala fixa de 2. O edital (§6.1)
lista como inválido "mais de 2 casas decimais" — não menos.

- **Consequência para idempotência:** o hash é calculado **após** a normalização (ADR-003
  §2), então `"25"` e `"25.00"` são o mesmo payload (replay), nunca conflito.
- **Risco assumido:** a frase "recebido e serializado como string decimal, sempre com
  escala fixa de 2 casas" admite uma leitura estrita. Se um avaliador enviar `"25.5"`
  esperando `400`, receberá `201` com `"25.50"`. Aceitamos o risco por alinhamento ao
  mercado; a mudança para estrito é local (uma regex) e coberta por testes.

Moeda: `^[A-Z]{3}$` **e** pertencente a uma allowlist configurável
(`SUPPORTED_CURRENCIES`, default `BRL,USD,EUR`). Todas operam com escala 2.

### 3. Serialização

- Fronteira (HTTP, SQS, eventos de outbox): sempre `{ "amount": "25.00", "currency": "BRL" }`.
- `toString()` produz escala fixa com sinal quando negativo (`"-5.00"`), via aritmética
  de `bigint` (`/ 100n` e `% 100n` com `padStart`), **sem** `toFixed`/`Number`.
- Eventos carregam `MoneyProps`, nunca a instância (§11).

### 4. Persistência

- Valor: `NUMERIC(19,2)`; moeda: `CHAR(3)` com `CHECK (currency ~ '^[A-Z]{3}$')`.
- O driver devolve `"25.00"` (string) → o mapper chama `Money.from(...)`. É proibido
  registrar *type parser* para OID 1700.
- Agregações SQL (reconciliação) usam `SUM(NUMERIC)` — exato — e retornam string.
- O domínio não conhece o ORM: o mapeamento está em `infrastructure/persistence`
  (ver ADR-005).

### 5. Guarda-corpos automatizados

- Regra de lint (`no-restricted-syntax` / script `check:money`) que falha o CI se
  `parseFloat`, `Number(`, `toFixed(`, `Math.round(` ou `: number` aparecerem em
  arquivos de `src/domain/**` e em DTOs/mappers monetários.
- Testes unitários cobrindo toda a tabela acima, imutabilidade (`Object.isFrozen`),
  conflito de moeda em **todas** as operações binárias e propriedade algébrica
  (`a.add(b).subtract(b).equals(a)`) com geração pseudoaleatória determinística (seed fixa).

### Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| `number` (float) | Inexato; eliminatório pelo edital. |
| Centavos em `number` (inteiro) | Exato até 2^53, mas ainda é `number` — viola a letra de §5.1 e abre porta a `/ 100`. |
| `decimal.js` / `big.js` | Precisão arbitrária desnecessária para operações aditivas; dependência extra; API `toNumber()` convida o erro. Seria a escolha se houvesse multiplicação/rateio. |
| `dinero.js` | Opinativo, v2 historicamente em alpha; acoplaria o domínio a uma lib externa. |
| Tipo monetário do ORM / `money` do PostgreSQL | Proibido por §6.1 (domínio não depende do ORM); o tipo `money` do PG depende de `lc_monetary`. |

## Consequências e Trade-offs

### Ganhos

- **Correção aritmética por construção**: não existe caminho de código que produza
  arredondamento ou deriva; o compilador recusa misturar `bigint` com `number`.
- **Zero dependências** para o núcleo financeiro; domínio puro e testável sem I/O.
- **Imutabilidade estrutural** (`readonly` + `Object.freeze`): um `balanceBefore`
  capturado num lançamento nunca muda depois.
- **Erros de contrato detectados na borda** (400) em vez de virar `500` no banco.
- `idempotency hash` estável: como o valor é normalizado (`"25"` ≡ `"25.00"`), o
  hash canônico (ADR-003) não diverge por formatação.

### Custos

- `bigint` não é serializável por `JSON.stringify` nativamente — exige `toJSON()`
  explícito (desejável, mas é disciplina a manter).
- Conversão string ↔ `bigint` em cada fronteira (custo de CPU desprezível frente ao I/O).
- A regra de lint pode gerar falsos positivos em código não monetário dentro do domínio
  (ex.: `version: number`), exigindo allowlist pontual.

### Limitações conhecidas

- **Escala fixa 2 para todas as moedas.** Moedas com 0 (JPY) ou 3 (KWD, BHD) casas não
  são suportadas; exigiriam um `CurrencyRegistry` com escala por moeda e colunas
  `NUMERIC(19,3)`. Mitigação: allowlist impede o cadastro dessas moedas.
- **Sem operações multiplicativas.** Se surgirem bônus percentuais ou rateios, esta
  decisão deve ser revista (provável migração para `decimal.js` com política explícita
  de arredondamento *banker's rounding*) em um novo ADR que substitua este.
- Teto de `99.999.999.999.999.999,99` por valor (limite de `NUMERIC(19,2)`).
