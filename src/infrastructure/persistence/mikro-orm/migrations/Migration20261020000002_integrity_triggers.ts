import { Migration } from '@mikro-orm/migrations';

/**
 * Triggers de integridade e privilégios mínimos (ADR-002 §2, ADR-003, ADR-004 §4).
 * Os REVOKE/triggers só protegem porque `wagering_app` não é dona das tabelas nem
 * superusuária; as migrations rodam como `wagering_owner`.
 */
export class Migration20261020000002_integrity_triggers extends Migration {
  override up(): void {
    // ---- Ledger: imutável -------------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION fn_ledger_immutable()`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION fn_ledger_immutable()`);

    // ---- Ledger: continuidade da corrente ---------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_ledger_assert_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        prev RECORD;
      BEGIN
        SELECT wallet_version, balance_after INTO prev
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;
        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 OR NEW.wallet_version NOT IN (1, 2) THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: first entry must start at balance 0 and wallet_version 1 or 2', NEW.wallet_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.wallet_version <> prev.wallet_version + 1
           OR NEW.balance_before <> prev.balance_after THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %', NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_assert_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION fn_ledger_assert_chain()`);

    // ---- Transações: identidade imutável; terminais não mudam -------------------------
    this.addSql(`
      CREATE FUNCTION fn_wtx_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transactions % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id                                IS DISTINCT FROM OLD.id
        OR NEW.provider_id                       IS DISTINCT FROM OLD.provider_id
        OR NEW.external_transaction_id           IS DISTINCT FROM OLD.external_transaction_id
        OR NEW.idempotency_key                   IS DISTINCT FROM OLD.idempotency_key
        OR NEW.payload_hash                      IS DISTINCT FROM OLD.payload_hash
        OR NEW.payload_hash_version              IS DISTINCT FROM OLD.payload_hash_version
        OR NEW.wallet_id                         IS DISTINCT FROM OLD.wallet_id
        OR NEW.player_id                         IS DISTINCT FROM OLD.player_id
        OR NEW.round_id                          IS DISTINCT FROM OLD.round_id
        OR NEW.game_id                           IS DISTINCT FROM OLD.game_id
        OR NEW.kind                              IS DISTINCT FROM OLD.kind
        OR NEW.amount                            IS DISTINCT FROM OLD.amount
        OR NEW.currency                          IS DISTINCT FROM OLD.currency
        OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
        OR NEW.correlation_id                    IS DISTINCT FROM OLD.correlation_id
        OR NEW.created_at                        IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wager_transactions % identity/payload columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status NOT IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transactions % cannot transition % -> %', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_wtx_immutable BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION fn_wtx_immutable()`);

    // ---- Wallets e transações: nunca excluídas (trilha de auditoria) -------------------
    this.addSql(`
      CREATE FUNCTION fn_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% rows are never deleted (% blocked)', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$`);
    for (const table of ['wager_transactions', 'wallets']) {
      this.addSql(`
        CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION fn_forbid_delete()`);
      this.addSql(`
        CREATE TRIGGER trg_${table}_no_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_delete()`);
    }

    // ---- Wallet: identidade imutável --------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_wallet_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.player_id IS DISTINCT FROM OLD.player_id
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wallets % identity columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_wallet_identity_immutable BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION fn_wallet_identity_immutable()`);

    // ---- Saldo materializado ↔ ledger (diferido até o COMMIT) -------------------------
    this.addSql(`
      CREATE FUNCTION fn_wallet_balance_has_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % must be inserted with version 1', NEW.id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF NEW.balance_amount > 0 AND NOT EXISTS (
               SELECT 1 FROM wallet_ledger_entries
                WHERE wallet_id = NEW.id AND wallet_version = 1 AND balance_after = NEW.balance_amount) THEN
            RAISE EXCEPTION 'wallet % opened with balance % has no matching opening ledger entry', NEW.id, NEW.balance_amount
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NULL;
        END IF;

        IF NEW.balance_amount <> OLD.balance_amount THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet % balance changed but version went % -> %', NEW.id, OLD.version, NEW.version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF NOT EXISTS (
               SELECT 1 FROM wallet_ledger_entries
                WHERE wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance_amount) THEN
            RAISE EXCEPTION 'wallet % balance changed to % without a matching ledger entry', NEW.id, NEW.balance_amount
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version changed without a balance change', NEW.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_balance_has_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION fn_wallet_balance_has_ledger()`);

    // ---- Outbox: payload imutável -----------------------------------------------------
    this.addSql(`
      CREATE FUNCTION fn_outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.seq IS DISTINCT FROM OLD.seq
        OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
        OR NEW.event_type IS DISTINCT FROM OLD.event_type
        OR NEW.event_version IS DISTINCT FROM OLD.event_version
        OR NEW.payload IS DISTINCT FROM OLD.payload
        OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox_messages % payload/identity columns are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_outbox_immutable BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION fn_outbox_immutable()`);

    // ---- Privilégios mínimos de wagering_app (matriz do ADR-002) ----------------------
    this.addSql(
      'GRANT SELECT, INSERT ON wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages TO wagering_app',
    );
    this.addSql('GRANT UPDATE ON wallets, wager_transactions, outbox_messages TO wagering_app');
    this.addSql('GRANT DELETE ON inbox_messages, outbox_messages TO wagering_app');
    this.addSql('REVOKE UPDATE, DELETE, TRUNCATE ON wallet_ledger_entries FROM wagering_app');
  }

  override down(): void {
    this.addSql(
      'REVOKE ALL ON wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages FROM wagering_app',
    );
    for (const table of ['wager_transactions', 'wallets']) {
      this.addSql(`DROP TRIGGER IF EXISTS trg_${table}_no_truncate ON ${table}`);
      this.addSql(`DROP TRIGGER IF EXISTS trg_${table}_no_delete ON ${table}`);
    }
    this.addSql('DROP FUNCTION IF EXISTS fn_forbid_delete()');
    this.addSql('DROP TRIGGER IF EXISTS trg_outbox_immutable ON outbox_messages');
    this.addSql('DROP FUNCTION IF EXISTS fn_outbox_immutable()');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_balance_has_ledger ON wallets');
    this.addSql('DROP FUNCTION IF EXISTS fn_wallet_balance_has_ledger()');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_identity_immutable ON wallets');
    this.addSql('DROP FUNCTION IF EXISTS fn_wallet_identity_immutable()');
    this.addSql('DROP TRIGGER IF EXISTS trg_wtx_immutable ON wager_transactions');
    this.addSql('DROP FUNCTION IF EXISTS fn_wtx_immutable()');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_assert_chain ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS fn_ledger_assert_chain()');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_immutable_truncate ON wallet_ledger_entries');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION IF EXISTS fn_ledger_immutable()');
  }
}
