/**
 * Plain Node checks for the pure parts of the renderer: AbbreviatedData parsing and OFD
 * delta-notation expansion. Neither needs a DOM, so this runs with bare `node`.
 *
 * Usage: node scripts/check-units.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;

// The modules are TypeScript, so load them through Vite's SSR transform.
const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

const { parseAbbreviatedData } = await server.ssrLoadModule('/src/render/paths.ts');
const { expandDelta } = await server.ssrLoadModule('/src/lib/page-parser.ts');

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

console.log('AbbreviatedData parsing');
check('move + line + close', () => {
  const commands = parseAbbreviatedData('M 0 0 L 10 0 L 10 5 Z');
  assert.deepEqual(commands, [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: 10, y: 0 },
    { type: 'L', x: 10, y: 5 },
    { type: 'Z' },
  ]);
});

check('implicit line after move (bare numbers)', () => {
  const commands = parseAbbreviatedData('0 0 10 0 10 5');
  assert.deepEqual(commands, [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: 10, y: 0 },
    { type: 'L', x: 10, y: 5 },
  ]);
});

check('relative operators', () => {
  const commands = parseAbbreviatedData('M 5 5 l 5 0 l 0 5');
  assert.deepEqual(commands, [
    { type: 'M', x: 5, y: 5 },
    { type: 'L', x: 10, y: 5 },
    { type: 'L', x: 10, y: 10 },
  ]);
});

check('cubic and quadratic curves', () => {
  const commands = parseAbbreviatedData('M 0 0 C 1 1 2 2 3 3 Q 4 4 5 5');
  assert.deepEqual(commands?.[1], { type: 'C', x1: 1, y1: 1, x2: 2, y2: 2, x: 3, y: 3 });
  assert.deepEqual(commands?.[2], { type: 'Q', x1: 4, y1: 4, x: 5, y: 5 });
});

check('OFD "B" is treated as a cubic', () => {
  const commands = parseAbbreviatedData('M 0 0 B 1 1 2 2 3 3');
  assert.equal(commands?.[1].type, 'C');
});

check('horizontal/vertical shorthand', () => {
  const commands = parseAbbreviatedData('M 0 0 H 10 V 10');
  assert.deepEqual(commands, [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: 10, y: 0 },
    { type: 'L', x: 10, y: 10 },
  ]);
});

check('arcs are rejected so the caller can fall back', () => {
  assert.equal(parseAbbreviatedData('M 0 0 A 5 5 0 0 1 10 10'), null);
});

check('garbage does not hang or throw', () => {
  assert.equal(parseAbbreviatedData('M 0 0 L x y'), null);
  assert.equal(parseAbbreviatedData('   '), null);
});

console.log('delta notation expansion');
check('plain advances', () => {
  assert.deepEqual(expandDelta('3 3 3', 7), [3, 3, 3]);
});

check('"g" means one glyph width', () => {
  assert.deepEqual(expandDelta('g', 7), [7]);
  assert.deepEqual(expandDelta('2 g', 7), [2, 7]);
});

check('"g N X" repeats X N times', () => {
  assert.deepEqual(expandDelta('g 3 2.5', 7), [2.5, 2.5, 2.5]);
});

check('bare numbers are one advance each (no ambiguous repeat guessing)', () => {
  assert.deepEqual(expandDelta('4 2', 7), [4, 2]);
  assert.deepEqual(expandDelta('2.5 3', 7), [2.5, 3]);
  assert.deepEqual(expandDelta('3 3 3', 7), [3, 3, 3]);
});

check('empty stays null', () => {
  assert.equal(expandDelta(undefined, 7), null);
  assert.equal(expandDelta('', 7), null);
});

// The shared coordinate helpers must also stay consistent.
const { multiply, applyMatrix, parseMatrix, parseBox } = await server.ssrLoadModule(
  '/src/render/types.ts',
);
console.log('geometry helpers');
check('matrix multiply matches sequential transforms', () => {
  const a = [2, 0, 0, 3, 10, 20];
  const b = [0, 1, -1, 0, 5, 5];
  const combined = multiply(a, b);
  const direct = applyMatrix(a, ...applyMatrix(b, 1, 1));
  const viaCombined = applyMatrix(combined, 1, 1);
  assert.ok(Math.abs(direct[0] - viaCombined[0]) < 1e-9);
  assert.ok(Math.abs(direct[1] - viaCombined[1]) < 1e-9);
});

check('matrix and box parsing tolerate junk', () => {
  assert.equal(parseMatrix('nope'), null);
  assert.deepEqual(parseMatrix('1 0 0 1 5 6'), [1, 0, 0, 1, 5, 6]);
  assert.deepEqual(parseBox('0 0 210 297'), { x: 0, y: 0, width: 210, height: 297 });
  assert.deepEqual(parseBox(''), { x: 0, y: 0, width: 0, height: 0 });
});

await server.close();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
void execFileSync;
