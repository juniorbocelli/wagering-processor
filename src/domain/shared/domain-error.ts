/**
 * Base de todos os erros de domínio. Carrega um `code` estável e legível por máquina,
 * independente da mensagem, para que camadas externas (HTTP, SQS) o traduzam sem
 * depender de `instanceof` em strings.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
