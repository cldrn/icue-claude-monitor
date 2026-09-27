// Loads the widget's classic (non-module) scripts into a vm sandbox and returns the CM namespace.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadCM(files) {
  const sandbox = { console, Date, Math, Number, String, JSON, isFinite, isNaN, parseInt, parseFloat, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, 'widget', 'scripts', f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return ctx.CM;
}
