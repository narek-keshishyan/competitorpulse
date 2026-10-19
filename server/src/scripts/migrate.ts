import { loadConfig } from '../config.js';
import { createDb } from '../db/connection.js';
import { migrateToLatest } from '../db/migrator.js';

const config = loadConfig();
const db = createDb(config.database);

try {
  const applied = await migrateToLatest(db);
  console.log(
    applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date',
  );
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
