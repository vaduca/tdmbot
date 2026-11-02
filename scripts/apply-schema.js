import { applySchema, createDatabaseClient } from './lib/database.js';

const client = createDatabaseClient();
try {
  await client.connect();
  await applySchema(client);
  console.log('Esquema PostgreSQL aplicado.');
} catch (error) {
  console.error('Não foi possível aplicar o esquema PostgreSQL:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
