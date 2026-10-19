import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// Postgres returns BIGINT (ids, counts) as strings because they can exceed
// Number.MAX_SAFE_INTEGER. Our ids will never get near 2^53, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export interface DbOptions {
  url: string;
  ssl?: boolean;
  poolMax?: number;
}

export type Db = Kysely<Database>;

export function createDb({ url, ssl = false, poolMax = 10 }: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    // Supabase's pooler presents a certificate that is not in Node's default CA bundle.
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
