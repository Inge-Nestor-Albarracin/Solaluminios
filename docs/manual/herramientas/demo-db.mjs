// Helper for LOCAL demo / rehearsal databases (only names starting with
// solaluminios_ensayo can be created, renamed or dropped). Uses the server and
// credentials of apps/api/.env (DATABASE_URL), replacing only the database
// name; the connection string is never printed.
//
//   node demo-db.mjs sql <db> "<sql>"        SELECT on any db; CREATE/ALTER/DROP DATABASE only
//                                           on solaluminios_ensayo* (run them against db "postgres")
//   node demo-db.mjs run <db> <command...>   runs a command in apps/api with DATABASE_URL → <db>
//   node demo-db.mjs admin <db>              create-admin with a random password,
//                                           saved to demo-admin.json (git-ignored)
//   node demo-db.mjs counts <db>             row counts of every table
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = fileURLToPath(new URL('../../../apps/api/', import.meta.url));
const require = createRequire(join(API, 'package.json'));
const dotenv = require('dotenv');
const pg = require('pg');

const base = new URL(dotenv.parse(readFileSync(join(API, '.env'))).DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('DATABASE_URL is not a local server');
const urlFor = (db) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};
const [mode, db, ...rest] = process.argv.slice(2);
const writable = (name) => /^solaluminios_ensayo[a-z0-9_]*$/.test(name);

if (mode === 'sql') {
  const sql = rest.join(' ');
  if (db !== 'postgres' && !/^\s*select/i.test(sql)) throw new Error('only SELECT outside the postgres database');
  if (db === 'postgres') {
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      if (/^select/i.test(statement)) continue;
      const names = [...statement.matchAll(/database\s+"?([a-z0-9_]+)"?/gi)].map((m) => m[1]);
      if (!/^(create|alter|drop) database/i.test(statement) || names.length === 0 || !names.every(writable)) {
        throw new Error(`refused: ${statement.slice(0, 80)}`);
      }
    }
  }
  const client = new pg.Client({ connectionString: urlFor(db) });
  await client.connect();
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    const res = await client.query(statement);
    console.log(res.command, res.rows?.length ? JSON.stringify(res.rows) : '');
  }
  await client.end();
} else if (mode === 'run' || mode === 'admin') {
  if (!writable(db)) throw new Error('only solaluminios_ensayo* databases');
  const env = { ...process.env, DATABASE_URL: urlFor(db) };
  let cmd = rest;
  if (mode === 'admin') {
    const password = randomBytes(15).toString('base64url');
    Object.assign(env, { BOOTSTRAP_ADMIN_NAME: 'Admin ensayo', BOOTSTRAP_ADMIN_EMAIL: 'admin-ensayo@test.local', BOOTSTRAP_ADMIN_PASSWORD: password });
    writeFileSync(new URL('./demo-admin.json', import.meta.url), JSON.stringify({ email: 'admin-ensayo@test.local', password }));
    cmd = ['node', 'dist/scripts/create-admin.js'];
  }
  const r = spawnSync(cmd.join(' '), { cwd: API, env, stdio: 'inherit', shell: true });
  process.exitCode = r.status ?? 1;
} else if (mode === 'counts') {
  const client = new pg.Client({ connectionString: urlFor(db) });
  await client.connect();
  const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY 1`)).rows.map((r) => r.tablename);
  const out = [];
  for (const t of tables) {
    const n = Number((await client.query(`SELECT count(*) FROM "${t}"`)).rows[0].count);
    if (n > 0) out.push(`${t}=${n}`);
  }
  const migrations = (await client.query(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`)).rows[0].count;
  console.log(`migraciones=${migrations} | con filas: ${out.join(' ') || '(ninguna)'} | tablas=${tables.length}`);
  await client.end();
} else {
  console.error('Uso: node demo-db.mjs sql|run|admin|counts <db> ...');
  process.exitCode = 1;
}
