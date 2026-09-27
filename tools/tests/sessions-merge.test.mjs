import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLiveness, encodeProjectDir, scanSessionsDir, compareVersions } from '../../server/sessions-local.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FT = '134349258090595993';
function file(pid, extra = {}) {
  return { pid, data: { pid, sessionId: 's' + pid, cwd: 'c:\\Users\\x\\GitHub\\proj' + pid, startedAt: 1790452209738, procStart: FT, version: '2.1.283', kind: 'interactive', entrypoint: 'claude-vscode', name: 'proj' + pid + '-ab', status: 'busy', updatedAt: 1, statusUpdatedAt: 2, ...extra } };
}

test('dead pids are dropped and counted as stale files', () => {
  const r = mergeLiveness([file(1), file(2)], new Set([1]), new Map(), new Map());
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].pid, 1);
  assert.equal(r.staleFiles, 1);
});

test('alive + matching process start -> verified procStart and cached', () => {
  const r = mergeLiveness([file(1)], new Set([1]), new Map([[1, FT]]), new Map());
  assert.equal(r.items[0].verified, 'procStart');
  assert.deepEqual(r.cacheUpdates.get(1), { procStart: FT, ok: true });
  assert.equal(r.items[0].project, 'proj1');
});

test('alive + mismatching process start -> pid reuse, dropped', () => {
  const r = mergeLiveness([file(1)], new Set([1]), new Map([[1, '134349258200595993']]), new Map());
  assert.equal(r.items.length, 0);
  assert.equal(r.reused, 1);
  assert.equal(r.cacheUpdates.get(1).ok, false);
});

test('alive but no PowerShell data -> verified pid, nothing cached', () => {
  const r1 = mergeLiveness([file(1)], new Set([1]), null, new Map());
  assert.equal(r1.items[0].verified, 'pid');
  assert.equal(r1.cacheUpdates.size, 0);
  const r2 = mergeLiveness([file(1)], new Set([1]), new Map(), new Map());
  assert.equal(r2.items[0].verified, 'pid');
});

test('cache hit skips the query result and a cached reuse verdict keeps the pid hidden', () => {
  const cache = new Map([[1, { procStart: FT, ok: true }], [2, { procStart: FT, ok: false }]]);
  const r = mergeLiveness([file(1), file(2)], new Set([1, 2]), new Map(), cache);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].verified, 'procStart');
  assert.equal(r.reused, 1);
  const changed = mergeLiveness([file(1, { procStart: '999' })], new Set([1]), new Map([[1, '999']]), cache);
  assert.equal(changed.items[0].verified, 'procStart', 'a changed procStart re-verifies against the fresh query');
});

test('scanSessionsDir ignores .key files and malformed json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-sessions-'));
  fs.writeFileSync(path.join(dir, '123.json'), JSON.stringify({ pid: 123, name: 'a' }));
  fs.writeFileSync(path.join(dir, '123.abc.key'), '{"peerToken":"x"}');
  fs.writeFileSync(path.join(dir, '456.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const r = scanSessionsDir(dir);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].pid, 123);
  assert.equal(r.malformed, 1);
  assert.equal(scanSessionsDir(path.join(dir, 'missing')).error, 'missing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('encodeProjectDir mirrors Claude Code project folder names', () => {
  assert.equal(encodeProjectDir('c:\\Users\\pauli\\GitHub\\icue-claude-monitor'), 'c--Users-pauli-GitHub-icue-claude-monitor');
  assert.equal(encodeProjectDir('c:\\Users\\pauli\\GitHub\\calderonpale.com'), 'c--Users-pauli-GitHub-calderonpale-com');
});

test('compareVersions', () => {
  assert.ok(compareVersions('2.1.283', '2.1.282') > 0);
  assert.ok(compareVersions('2.1.9', '2.1.10') < 0);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
});
