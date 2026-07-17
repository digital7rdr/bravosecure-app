import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, extname} from 'node:path';

/**
 * Log-audit — DoD #8 closer.
 *
 * Every `.log(...)`, `.warn(...)`, `.error(...)`, `.debug(...)`, and
 * plain `console.*` call in the messenger client + messenger-service
 * must NOT reference variables that carry plaintext content, keys,
 * or decrypted blobs.
 *
 * The check is conservative by design — it matches a set of BANNED
 * IDENTIFIERS that could plausibly carry secret material. If the
 * test fails, either rename your variable (e.g. `pt` → `ptLen`) or
 * drop the log.
 *
 * Runs as a Jest test so CI fails loudly if regressed.
 */

const BANNED_IDENTIFIER_PATTERNS: ReadonlyArray<RegExp> = [
  // Direct content references
  /\bplaintext\b/,
  /\.content\b/,
  /\bmsg\.body\b/,
  /\bbody\.body\b/,
  /\bsealed\.body\b/,

  // Keys + ciphertext material
  /\bprivKey\b/,
  /\bprivateKey\b/,
  /\bkeyB64\b/,
  /\bivB64\b/,
  /\bmasterKey(?!Id)\b/,  // masterKeyId is fine; masterKey / masterKeyB64 is not
  /\bsignature\b/,
  /\bsenderIdentityKey\b/,

  // Decrypted bytes
  /\bdecrypt(ed)?\b/,
  /\bunsealed\b/,
];

/** Files we DO want to scan — source + specs (but not these audit tests). */
const CLIENT_ROOT = join(process.cwd(), 'src', 'modules', 'messenger');
const SERVER_ROOT = join(process.cwd(), 'apps', 'messenger-service', 'src');

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') {continue;}
      yield* walkTs(full);
    } else if (st.isFile()) {
      const ext = extname(name);
      if (ext === '.ts' || ext === '.tsx') {yield full;}
    }
  }
}

interface Offense {
  file: string;
  line: number;
  snippet: string;
  match: string;
}

function findOffensesIn(file: string): Offense[] {
  const src = readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const out: Offense[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only inspect lines that look like a logging call.
    const isLogCall = /\b(log|warn|error|debug|info)\s*\(/.test(line)
                   || /\bconsole\.(log|warn|error|debug|info)\s*\(/.test(line);
    if (!isLogCall) {continue;}
    for (const pattern of BANNED_IDENTIFIER_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        out.push({file, line: i + 1, snippet: line.trim(), match: m[0]});
      }
    }
  }
  return out;
}

describe('Log audit — no plaintext content / keys / decrypted blobs in any log call', () => {
  it('messenger client code path has zero offenses', () => {
    const all: Offense[] = [];
    for (const f of walkTs(CLIENT_ROOT)) {
      // Skip the audit test itself — it legitimately mentions banned names.
      if (f.endsWith('logAudit.test.ts')) {continue;}
      all.push(...findOffensesIn(f));
    }
    if (all.length > 0) {
      const report = all.map(o => `  ${o.file}:${o.line}: matched /${o.match}/ in "${o.snippet}"`).join('\n');
      throw new Error(`Found ${all.length} forbidden log reference(s):\n${report}`);
    }
    expect(all).toEqual([]);
  });

  it('messenger-service code path has zero offenses', () => {
    const all: Offense[] = [];
    for (const f of walkTs(SERVER_ROOT)) {
      all.push(...findOffensesIn(f));
    }
    if (all.length > 0) {
      const report = all.map(o => `  ${o.file}:${o.line}: matched /${o.match}/ in "${o.snippet}"`).join('\n');
      throw new Error(`Found ${all.length} forbidden log reference(s):\n${report}`);
    }
    expect(all).toEqual([]);
  });
});
