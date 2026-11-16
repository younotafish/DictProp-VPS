/**
 * Evaluates the CSS lengths the layout tests compare, without a browser: a Tailwind arbitrary value (the text between
 * a class's brackets, where `_` stands for a space and Tailwind adds the spaces calc() needs around + and -), or a
 * custom property's value from src/index.css, which the browser reads as written. It knows px, rem (16px), vw, unitless
 * factors, calc(), min(), max(), clamp(), env(safe-area-inset-bottom) and var() with or without a fallback; anything
 * else throws, so a test never passes on a value it misread.
 */

export interface CssLengthContext {
  /** env(safe-area-inset-bottom) in px: 0 on a laptop, 34 on a Face ID iPhone held upright. */
  insetBottom: number;
  /** The viewport's width in px, for vw. */
  vw: number;
  /** Custom properties by name ('--nav-h'), as CSS text; readRootVars reads src/index.css's. */
  vars?: Record<string, string>;
}

interface Token {
  kind: 'number' | 'name' | 'property' | 'punct';
  text: string;
  value?: number;
  unit?: string;
  /** Whitespace came right before it. */
  spaced: boolean;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let spaced = false;
  while (at < text.length) {
    const char = text[at];
    if (/\s/.test(char)) { spaced = true; at++; continue; }
    const rest = text.slice(at);
    const number = /^(\d*\.?\d+)([a-zA-Z%]*)/.exec(rest);
    const property = /^--[A-Za-z0-9-]+/.exec(rest);
    const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(rest);
    let token: Token;
    if (number) token = { kind: 'number', text: number[0], value: Number(number[1]), unit: number[2].toLowerCase(), spaced };
    else if (property) token = { kind: 'property', text: property[0], spaced };
    else if (name) token = { kind: 'name', text: name[0], spaced };
    else if ('+-*/(),'.includes(char)) token = { kind: 'punct', text: char, spaced };
    else throw new Error(`cssLength: unexpected ${JSON.stringify(char)} in ${JSON.stringify(text)}`);
    tokens.push(token);
    at += token.text.length;
    spaced = false;
  }
  return tokens;
}

/** A length in px, or a plain number (a factor for * and /). */
interface Value { px: number; unitless: boolean }

const MAX_VAR_DEPTH = 10;

function evaluate(text: string, context: CssLengthContext, strict: boolean, depth: number): Value {
  if (depth > MAX_VAR_DEPTH) throw new Error(`cssLength: var() nests too deep at ${JSON.stringify(text)}`);
  const tokens = tokenize(text);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const fail = (why: string): never => { throw new Error(`cssLength: ${why} in ${JSON.stringify(text)}`); };
  const expect = (punct: string) => {
    if (peek()?.text !== punct) fail(`expected ${JSON.stringify(punct)}`);
    at++;
  };
  // The text up to the ')' that closes the current call, for a var() or env() fallback, which can hold anything.
  const restOfCall = (): string => {
    let depthHere = 0;
    const start = at;
    while (at < tokens.length) {
      const token = tokens[at];
      if (token.text === '(') depthHere++;
      if (token.text === ')') { if (depthHere === 0) break; depthHere--; }
      at++;
    }
    return tokens.slice(start, at).map(token => `${token.spaced ? ' ' : ''}${token.text}`).join('');
  };

  const sum = (): Value => {
    let left = product();
    for (let op = peek(); op?.text === '+' || op?.text === '-'; op = peek()) {
      // The browser reads `1px+2px` as one broken token: calc() needs a space on each side of + and -.
      if (strict && (!op.spaced || !tokens[at + 1]?.spaced)) fail(`"${op.text}" needs a space on each side`);
      at++;
      const right = product();
      if (left.unitless !== right.unitless) fail(`"${op.text}" mixes a length and a plain number`);
      left = { px: op.text === '+' ? left.px + right.px : left.px - right.px, unitless: left.unitless };
    }
    return left;
  };
  const product = (): Value => {
    let left = unary();
    for (let op = peek(); op?.text === '*' || op?.text === '/'; op = peek()) {
      at++;
      const right = unary();
      if (op.text === '*') {
        if (!left.unitless && !right.unitless) fail('"*" multiplies two lengths');
        left = { px: left.px * right.px, unitless: left.unitless && right.unitless };
      } else {
        if (!right.unitless) fail('"/" divides by a length');
        left = { px: left.px / right.px, unitless: left.unitless };
      }
    }
    return left;
  };
  const unary = (): Value => {
    const sign = peek()?.text;
    if (sign === '-' || sign === '+') {
      at++;
      const value = unary();
      return sign === '-' ? { ...value, px: -value.px } : value;
    }
    return primary();
  };
  const list = (): Value[] => {
    const values = [sum()];
    while (peek()?.text === ',') { at++; values.push(sum()); }
    return values;
  };
  const sameKind = (values: Value[], name: string): boolean => {
    if (values.some(value => value.unitless !== values[0].unitless)) fail(`${name}() mixes lengths and plain numbers`);
    return values[0].unitless;
  };
  const primary = (): Value => {
    const token = peek();
    if (!token) return fail('ran out of text');
    at++;
    if (token.kind === 'number') {
      const value = token.value!;
      switch (token.unit) {
        case '': return { px: value, unitless: true };
        case 'px': return { px: value, unitless: false };
        case 'rem': return { px: value * 16, unitless: false };
        case 'vw': return { px: (value * context.vw) / 100, unitless: false };
        default: return fail(`unknown unit "${token.unit}"`);
      }
    }
    if (token.text === '(') {
      const value = sum();
      expect(')');
      return value;
    }
    if (token.kind !== 'name') return fail(`unexpected "${token.text}"`);
    expect('(');
    let value: Value;
    switch (token.text) {
      case 'calc': value = sum(); break;
      case 'min': case 'max': {
        const values = list();
        value = { px: Math[token.text](...values.map(item => item.px)), unitless: sameKind(values, token.text) };
        break;
      }
      case 'clamp': {
        const values = list();
        if (values.length !== 3) fail('clamp() takes three values');
        const [low, preferred, high] = values;
        value = { px: Math.max(low.px, Math.min(preferred.px, high.px)), unitless: sameKind(values, 'clamp') };
        break;
      }
      case 'env': {
        const name = peek();
        if (name?.text !== 'safe-area-inset-bottom') fail(`env(${name?.text ?? ''}) is not one this knows`);
        at++;
        if (peek()?.text === ',') { at++; restOfCall(); }
        value = { px: context.insetBottom, unitless: false };
        break;
      }
      case 'var': {
        const property = peek();
        if (property?.kind !== 'property') fail('var() needs a custom property name');
        at++;
        const fallback = peek()?.text === ',' ? (at++, restOfCall()) : undefined;
        const defined = context.vars?.[property!.text];
        // A custom property's value is CSS as written; a fallback inside a Tailwind value is Tailwind's.
        if (defined !== undefined) value = evaluate(defined, context, true, depth + 1);
        else if (fallback !== undefined) value = evaluate(fallback, context, strict, depth + 1);
        else value = fail(`${property!.text} is not defined and has no fallback`);
        break;
      }
      default: return fail(`unknown function ${token.text}()`);
    }
    expect(')');
    return value;
  };

  const result = sum();
  if (at !== tokens.length) fail(`unexpected "${tokens[at].text}"`);
  return result;
}

/** The length `expr` comes to, in px. `expr` is a Tailwind arbitrary value, as written between a class's brackets. */
export function cssLength(expr: string, context: CssLengthContext): number {
  const value = evaluate(expr.replaceAll('_', ' '), context, false, 0);
  if (value.unitless && value.px !== 0) throw new Error(`cssLength: ${JSON.stringify(expr)} is a plain number, not a length`);
  return value.px;
}

/** The custom properties `cssText` sets on :root, by name, with their values as written. */
export function readRootVars(cssText: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const declaration of block[1].matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) vars[declaration[1]] = declaration[2].trim();
  }
  return vars;
}

/** The arbitrary value of the `utility` class in `classes` (for 'pb' and 'pb-[2rem]', '2rem'), or null without one. */
export function arbitraryValue(classes: string | readonly string[], utility: string): string | null {
  const list = typeof classes === 'string' ? classes.split(/\s+/) : classes;
  const prefix = `${utility}-[`;
  const found = list.find(name => name.startsWith(prefix) && name.endsWith(']'));
  return found ? found.slice(prefix.length, -1) : null;
}
