import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import * as m0001 from './migrations/0001_initial.js';

// Migrations are imported explicitly rather than read from disk, so they work the same
// from TypeScript sources, compiled output and inside the container image.
const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
};

const provider: MigrationProvider = {
  getMigrations: async () => migrations,
};

export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({ db, provider });
  const { error, results = [] } = await migrator.migrateToLatest();

  const failed = results.find((r) => r.status === 'Error');
  if (error || failed) {
    const reason = error instanceof Error ? error.message : String(error ?? '');
    throw new Error(`Migration ${failed?.migrationName ?? ''} failed: ${reason}`);
  }
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
