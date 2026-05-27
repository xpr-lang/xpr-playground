#!/usr/bin/env node
// pyodide-smoke.mjs -- offline integration test for vendored Pyodide + xpr-lang.
//
// Loads Pyodide from public/vendor/ via file:// URLs (NO network), installs
// the vendored xpr-lang wheel through micropip, then evaluates an xpr
// expression to prove the full Python-runtime chain works without any CDN.
//
// Exit: 0 on success, 1 on any failure. Prints the evaluator's result so the
// shell wrapper / CI can grep for "6".

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_PYODIDE = resolve(HERE, '..', 'public', 'vendor', 'pyodide-0.27.5');
const VENDOR_WHEEL = resolve(HERE, '..', 'public', 'vendor', 'wheels', 'xpr_lang-0.5.0-py3-none-any.whl');

function die(msg, err) {
  console.error(`[smoke] FAIL: ${msg}`);
  if (err) console.error(err.stack || err);
  process.exit(1);
}

// In Node, Pyodide treats indexURL as a filesystem path (passes it through
// path.resolve); file:// URLs get mangled. Browser path resolution is via
// new URL(...) and DOES want a file:// URL. We are in Node here.
const pyodideMjsUrl = pathToFileURL(resolve(VENDOR_PYODIDE, 'pyodide.mjs')).href;
const indexURL = VENDOR_PYODIDE + '/';
const wheelURL = pathToFileURL(VENDOR_WHEEL).href;

console.log(`[smoke] indexURL = ${indexURL}`);
console.log(`[smoke] wheel    = ${wheelURL}`);

const { loadPyodide, version } = await import(pyodideMjsUrl).catch((e) =>
  die(`could not import pyodide.mjs at ${pyodideMjsUrl}`, e)
);

if (version !== '0.27.5') {
  die(`expected Pyodide version 0.27.5, got ${version}`);
}

console.log(`[smoke] Pyodide module loaded (version ${version})`);

const pyodide = await loadPyodide({ indexURL }).catch((e) =>
  die('loadPyodide failed', e)
);
console.log('[smoke] Pyodide runtime initialised');

await pyodide.loadPackage('micropip').catch((e) =>
  die('loadPackage(micropip) failed -- vendor missing micropip+packaging wheels?', e)
);
console.log('[smoke] micropip loaded');

const micropip = pyodide.pyimport('micropip');
await micropip.install(wheelURL).catch((e) =>
  die(`micropip.install(${wheelURL}) failed`, e)
);
console.log('[smoke] xpr-lang wheel installed via micropip');

const result = pyodide.runPython(`
from xpr import Xpr
Xpr().evaluate('[1,2,3].sum()', {})
`);

console.log(`[smoke] xpr evaluate('[1,2,3].sum()', {}) = ${result}`);

const numeric = Number(result);
if (!Number.isFinite(numeric) || numeric !== 6) {
  die(`expected 6 (or 6.0); got ${result} (typeof ${typeof result})`);
}

console.log('[smoke] PASS');
process.exit(0);
