const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    for (const file of migrationFiles) {
      const { rowCount } = await client.query(
        'select 1 from schema_migrations where filename = $1 limit 1',
        [file]
      );
      if (rowCount > 0) {
        console.log(`skip ${file}`);
        continue;
      }

      console.log(`apply ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
