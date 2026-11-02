import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

export function createDatabaseClient() {
  if (process.env.DATABASE_URL) {
    return new Client({ connectionString: process.env.DATABASE_URL });
  }
  return new Client();
}

export async function applySchema(client) {
  const schema = await readFile(new URL('../../src/database/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
}
