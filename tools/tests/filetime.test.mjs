import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filetimeToMs, procStartMatches, parseProcList, queryProcStarts, pidAlive } from '../../server/procs.mjs';

test('filetimeToMs: epoch and a real sample from ~/.claude/sessions', () => {
  assert.equal(filetimeToMs('116444736000000000'), 0);
  const ms = filetimeToMs('134349258090595993');
  assert.ok(Math.abs(ms - 1790452209738) < 2000, `off by ${ms - 1790452209738} ms`);
  assert.ok(Number.isNaN(filetimeToMs('nope')));
});

test('procStartMatches tolerates 10 ms, rejects 1 s, handles garbage', () => {
  assert.equal(procStartMatches('134349258090595993', '134349258090595993'), true);
  assert.equal(procStartMatches('134349258090595993', '134349258090595983'), true);
  assert.equal(procStartMatches('134349258090595993', '134349258100595993'), false);
  assert.equal(procStartMatches(null, '1'), false);
  assert.equal(procStartMatches('abc', '1'), false);
});

test('parseProcList handles empty, single object and array output', () => {
  assert.deepEqual(parseProcList(''), []);
  assert.deepEqual(parseProcList('{"pid":1,"ft":"2"}'), [{ pid: 1, ft: '2' }]);
  assert.deepEqual(parseProcList('[{"pid":1,"ft":"2"},{"pid":2,"ft":3}]'), [{ pid: 1, ft: '2' }, { pid: 2, ft: '3' }]);
  assert.deepEqual(parseProcList('[{"pid":"x"}]'), []);
});

test('queryProcStarts uses a single PowerShell call and degrades to null on failure', async () => {
  const calls = [];
  const okExec = (cmd, args, opts, cb) => { calls.push({ cmd, args }); cb(null, '[{"pid":10,"ft":"5"},{"pid":20,"ft":"6"}]'); };
  const m = await queryProcStarts([10, 20, 10], { exec: okExec });
  if (process.platform === 'win32') {
    assert.equal(calls.length, 1);
    assert.match(calls[0].args.join(' '), /Get-Process -Id 10,20 /);
    assert.equal(m.get(10), '5');
    assert.equal(m.get(20), '6');
    const bad = await queryProcStarts([1], { exec: (c, a, o, cb) => cb(new Error('boom')) });
    assert.equal(bad, null);
  } else {
    assert.equal(m, null);
  }
  assert.deepEqual(await queryProcStarts([], { exec: okExec }), new Map());
});

test('pidAlive for own pid and an impossible pid', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(2147483646), false);
});
