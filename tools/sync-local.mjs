// Copies widget/ into iCUE's html_widgets folder for fast iteration without re-importing.
// iCUE must be restarted (or the widget removed/re-added on the screen) to pick up changes.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const src = path.resolve('widget');
if (!process.env.APPDATA) { console.error('APPDATA is not set'); process.exit(1); }
const dest = path.join(process.env.APPDATA, 'Corsair', 'CUE5', 'html_widgets', 'com', 'calderon', 'claudemonitor');
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('synced widget/ ->', dest);
