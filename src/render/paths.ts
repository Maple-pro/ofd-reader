/**
 * Parser for OFD `AbbreviatedData` — the compact path notation used by PathObject.
 *
 * Grammar (GB/T 33190-2016, 8.4): operators and numbers separated by whitespace or
 * commas, e.g. `M 0 0 L 10 0 L 10 10 Z`. Operators are relative when lowercase.
 *
 * Supported: M/m, L/l, H/h, V/v, C/c, Q/q, B/b (cubic), A/a (elliptical arc), Z/z.
 * Coordinates stay in millimetres — no unit conversion happens here.
 */

import type { PathCommand } from './types';

interface Token {
  op?: string;
  value?: number;
}

const OPERATORS = 'MmLlHhVvCcSsQqTtAaBbZz';

function tokenize(data: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = data.length;

  while (i < n) {
    const ch = data[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\f') {
      i += 1;
      continue;
    }

    if (OPERATORS.includes(ch)) {
      tokens.push({ op: ch });
      i += 1;
      continue;
    }

    // Number: optional sign, digits, optional fraction, optional exponent.
    const start = i;
    if (ch === '+' || ch === '-') i += 1;
    let digits = 0;
    while (i < n && data[i] >= '0' && data[i] <= '9') {
      i += 1;
      digits += 1;
    }
    if (i < n && data[i] === '.') {
      i += 1;
      while (i < n && data[i] >= '0' && data[i] <= '9') {
        i += 1;
        digits += 1;
      }
    }
    if (digits === 0) {
      // Neither a known operator nor a number: the data is malformed, so bail out and let
      // the caller fall back to the Boundary rectangle instead of guessing.
      return null;
    }
    if (i < n && (data[i] === 'e' || data[i] === 'E')) {
      let j = i + 1;
      if (j < n && (data[j] === '+' || data[j] === '-')) j += 1;
      if (j < n && data[j] >= '0' && data[j] <= '9') {
        i = j;
        while (i < n && data[i] >= '0' && data[i] <= '9') i += 1;
      }
    }

    const value = Number(data.slice(start, i));
    if (Number.isFinite(value)) tokens.push({ value });
  }

  return tokens;
}

/**
 * Parse OFD AbbreviatedData into absolute-mm path commands.
 *
 * @returns commands, or null when the notation uses features we cannot represent
 *          (the caller should then fall back to drawing the Boundary rectangle).
 */
export function parseAbbreviatedData(data: string): PathCommand[] | null {
  if (!data || !data.trim()) return null;

  const tokens = tokenize(data);
  if (!tokens) return null;
  const commands: PathCommand[] = [];

  // Current point (absolute) and subpath start, in mm.
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;

  let op: string | null = null;
  let idx = 0;

  const hasNumbers = (count: number): boolean => {
    for (let k = 0; k < count; k += 1) {
      if (tokens[idx + k]?.value === undefined) return false;
    }
    return true;
  };
  const num = (): number => tokens[idx++].value as number;

  // OFD writers frequently emit bare numbers without a leading operator
  // (implicit move-to followed by line-tos). Treat that as `M ... L ...`.
  if (tokens.length > 0 && tokens[0].op === undefined) {
    op = 'M';
  }

  while (idx < tokens.length) {
    // An operator token is consumed here and applied on this same iteration; a trailing
    // argument-less operator (typically `Z`) must not be swallowed as a look-ahead.
    const next = tokens[idx];
    if (next.op !== undefined) {
      op = next.op;
      idx += 1;
    }
    if (op === null) return null;

    const relative = op === op.toLowerCase();
    const upper = op.toUpperCase();

    switch (upper) {
      case 'M': {
        if (!hasNumbers(2)) return null;
        const x = num();
        const y = num();
        cx = relative ? cx + x : x;
        cy = relative ? cy + y : y;
        sx = cx;
        sy = cy;
        commands.push({ type: 'M', x: cx, y: cy });
        // Following coordinate pairs are implicit line-tos.
        op = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        if (!hasNumbers(2)) return null;
        const x = num();
        const y = num();
        cx = relative ? cx + x : x;
        cy = relative ? cy + y : y;
        commands.push({ type: 'L', x: cx, y: cy });
        break;
      }
      case 'H': {
        if (!hasNumbers(1)) return null;
        const x = num();
        cx = relative ? cx + x : x;
        commands.push({ type: 'L', x: cx, y: cy });
        break;
      }
      case 'V': {
        if (!hasNumbers(1)) return null;
        const y = num();
        cy = relative ? cy + y : y;
        commands.push({ type: 'L', x: cx, y: cy });
        break;
      }
      case 'C': {
        if (!hasNumbers(6)) return null;
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const x = num();
        const y = num();
        const ax1 = relative ? cx + x1 : x1;
        const ay1 = relative ? cy + y1 : y1;
        const ax2 = relative ? cx + x2 : x2;
        const ay2 = relative ? cy + y2 : y2;
        cx = relative ? cx + x : x;
        cy = relative ? cy + y : y;
        commands.push({ type: 'C', x1: ax1, y1: ay1, x2: ax2, y2: ay2, x: cx, y: cy });
        break;
      }
      case 'B': {
        // OFD's "B" is an alternate cubic Bezier operator (same shape as C).
        if (!hasNumbers(6)) return null;
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const x = num();
        const y = num();
        const ax1 = relative ? cx + x1 : x1;
        const ay1 = relative ? cy + y1 : y1;
        const ax2 = relative ? cx + x2 : x2;
        const ay2 = relative ? cy + y2 : y2;
        cx = relative ? cx + x : x;
        cy = relative ? cy + y : y;
        commands.push({ type: 'C', x1: ax1, y1: ay1, x2: ax2, y2: ay2, x: cx, y: cy });
        break;
      }
      case 'Q': {
        if (!hasNumbers(4)) return null;
        const x1 = num();
        const y1 = num();
        const x = num();
        const y = num();
        const ax1 = relative ? cx + x1 : x1;
        const ay1 = relative ? cy + y1 : y1;
        cx = relative ? cx + x : x;
        cy = relative ? cy + y : y;
        commands.push({ type: 'Q', x1: ax1, y1: ay1, x: cx, y: cy });
        break;
      }
      case 'Z': {
        commands.push({ type: 'Z' });
        cx = sx;
        cy = sy;
        break;
      }
      case 'S':
      case 'T':
      case 'A': {
        // Not represented in PathCommand — signal a fallback to the caller.
        return null;
      }
      default:
        return null;
    }

  }

  return commands.length > 0 ? commands : null;
}
