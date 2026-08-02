/**
 * Static validation for the SQL migrations.
 *
 * No database is required. This parses every migration with PostgreSQL's own
 * grammar via libpg-query, so a syntax error is caught in CI rather than at
 * deploy time.
 *
 * What it does NOT do, and cannot: PL/pgSQL bodies are opaque string literals
 * to the parser, so the contents of `language plpgsql` functions are unchecked.
 * Nor is anything semantic verified — a column that does not exist, or a type
 * mismatch, will parse perfectly. Only `supabase db reset` proves those.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, parse } from 'libpg-query';

const DIR = 'supabase/migrations';
const TEST_DIR = 'supabase/tests/database';

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const read = (f) => readFileSync(join(DIR, f), 'utf8');

// The pgTAP suite only runs where Docker runs, which is CI. Parsing it here
// means a syntax error in a test surfaces on the same command as everything
// else rather than several minutes into a container build.
const testFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith('.sql')).sort();

await loadModule();

let failures = 0;

// --- 1. Every migration must parse -----------------------------------------
for (const file of files) {
  try {
    await parse(read(file));
  } catch (error) {
    failures += 1;
    console.error(`syntax error in ${file}: ${String(error.message).split('\n')[0]}`);
  }
}

// --- 1b. So must every database test ----------------------------------------
for (const file of testFiles) {
  try {
    await parse(readFileSync(join(TEST_DIR, file), 'utf8'));
  } catch (error) {
    failures += 1;
    console.error(`syntax error in ${TEST_DIR}/${file}: ${String(error.message).split('\n')[0]}`);
  }
}

// --- 2. `language sql` bodies are real SQL, so parse those too --------------
let bodies = 0;
const BODY = /language\s+sql[\s\S]{0,160}?as\s+\$\$([\s\S]*?)\$\$/gi;
for (const file of files) {
  const sql = read(file);
  let match;
  while ((match = BODY.exec(sql))) {
    const body = match[1].trim().replace(/;\s*$/, '');
    if (!body) continue;
    bodies += 1;
    try {
      await parse(`${body};`);
    } catch (error) {
      failures += 1;
      console.error(`function body in ${file}: ${String(error.message).split('\n')[0]}`);
    }
  }
}

// --- 3. Every schema-qualified reference must be created somewhere ----------
// Catches the mistake of using a table or function a migration never defines,
// which is otherwise only found by running the whole stack.
const objects = new Set();
const CREATORS = [
  /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gi,
  /create\s+(?:or\s+replace\s+)?view\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gi,
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gi,
  /create\s+type\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gi,
  /create\s+sequence\s+(?:if\s+not\s+exists\s+)?(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gi,
  // A rename creates a name as surely as a create does.
  /rename\s+to\s+([a-z0-9_]+)/gi,
];
const REFERENCE = /\b(?:halal_mode_private|public)\.([a-z0-9_]+)/gi;
// `drop ... if exists` is deliberately tolerant of something never created.
const DROPPED = /drop\s+\w+\s+if\s+exists\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)/gi;

for (const file of files) {
  const sql = read(file);
  for (const creator of CREATORS) {
    creator.lastIndex = 0;
    let match;
    while ((match = creator.exec(sql))) objects.add(match[1]);
  }
  DROPPED.lastIndex = 0;
  let dropped;
  while ((dropped = DROPPED.exec(sql))) objects.add(dropped[1]);

  REFERENCE.lastIndex = 0;
  let reference;
  while ((reference = REFERENCE.exec(sql))) {
    if (objects.has(reference[1])) continue;
    failures += 1;
    console.error(`${file} references ${reference[1]}, which no migration creates`);
    objects.add(reference[1]);
  }
}

console.log(
  `${files.length} migrations parsed, ${testFiles.length} database tests parsed, `
    + `${bodies} language-sql bodies parsed, ${failures} problem(s)`
);
if (failures > 0) process.exit(1);
