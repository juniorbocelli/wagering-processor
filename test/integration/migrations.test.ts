import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connect, ensureSchema, sql } from '../support/db.ts';

const TABLES = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];
const FUNCTIONS = [
  'fn_ledger_immutable',
  'fn_ledger_assert_chain',
  'fn_wtx_immutable',
  'fn_wallet_identity_immutable',
  'fn_wallet_balance_has_ledger',
  'fn_outbox_immutable',
];
const RETENTION_INDEXES = ['ix_inbox_processed', 'ix_outbox_published'];

let owner: MikroORM;

beforeAll(async () => {
  await ensureSchema();
  owner = await connect('owner', 2);
});

afterAll(async () => {
  await ensureSchema(); // deixa o schema aplicado para as demais suítes
  await owner.close();
});

const indexes = async (): Promise<string[]> => {
  const rows = await sql<{ name: string }>(
    owner,
    `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (${RETENTION_INDEXES.map(() => '?').join(', ')})`,
    RETENTION_INDEXES,
  );
  return rows.map((r) => r.name).sort();
};

const existing = async (names: string[], catalog: 'tables' | 'functions') => {
  const marks = names.map(() => '?').join(', ');
  const rows =
    catalog === 'tables'
      ? await sql<{ name: string }>(
          owner,
          `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${marks})`,
          names,
        )
      : await sql<{ name: string }>(
          owner,
          `SELECT proname AS name FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${marks})`,
          names,
        );
  return rows.map((r) => r.name).sort();
};

describe('migrations are reversible', () => {
  test('up → down (all) → up leaves the full schema in place and nothing behind', async () => {
    expect(await existing(TABLES, 'tables')).toEqual([...TABLES].sort());
    expect(await existing(FUNCTIONS, 'functions')).toEqual([...FUNCTIONS].sort());
    expect(await indexes()).toEqual(RETENTION_INDEXES);

    const reverted = await owner.migrator.down({ to: 0 });
    expect(reverted.map((m) => m.name)).toEqual([
      'Migration20261021000003_retention_indexes',
      'Migration20261020000002_integrity_triggers',
      'Migration20261020000001_initial',
    ]);
    expect(await existing(TABLES, 'tables')).toEqual([]);
    expect(await existing(FUNCTIONS, 'functions')).toEqual([]);
    expect(await indexes()).toEqual([]);

    const applied = await owner.migrator.up();
    expect(applied.map((m) => m.name)).toEqual([
      'Migration20261020000001_initial',
      'Migration20261020000002_integrity_triggers',
      'Migration20261021000003_retention_indexes',
    ]);
    expect(await existing(TABLES, 'tables')).toEqual([...TABLES].sort());
    expect(await existing(FUNCTIONS, 'functions')).toEqual([...FUNCTIONS].sort());
    expect(await indexes()).toEqual(RETENTION_INDEXES);
  });

  test('the retention-indexes migration alone can be reverted and reapplied', async () => {
    await owner.migrator.down();
    expect(await indexes()).toEqual([]);
    expect(await existing(FUNCTIONS, 'functions')).toEqual([...FUNCTIONS].sort());
    await owner.migrator.up();
    expect(await indexes()).toEqual(RETENTION_INDEXES);
  });

  test('the triggers migration (and what depends on it) can be reverted and reapplied', async () => {
    await owner.migrator.down({ to: 'Migration20261020000001_initial' });
    expect(await existing(FUNCTIONS, 'functions')).toEqual([]);
    expect(await existing(TABLES, 'tables')).toEqual([...TABLES].sort());
    await owner.migrator.up();
    expect(await existing(FUNCTIONS, 'functions')).toEqual([...FUNCTIONS].sort());
    expect(await indexes()).toEqual(RETENTION_INDEXES);
  });

  test('there is nothing pending after up', async () => {
    expect(await owner.migrator.getPending()).toEqual([]);
  });
});
