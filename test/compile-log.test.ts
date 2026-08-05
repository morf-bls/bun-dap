import { test, expect } from 'bun:test';
import { compileLogMessage } from '../src/adapter/adapter';

/** Evaluate a compiled log expression in a scope with the given bindings. */
function evalCompiled(compiled: string, bindings: Record<string, unknown> = {}): unknown {
  const keys = Object.keys(bindings);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...keys, `"use strict"; return (${compiled});`);
  return fn(...keys.map((k) => bindings[k]));
}

test('L24: compileLogMessage handles plain text and single interpolation', () => {
  expect(compileLogMessage('plain')).toBe('"plain"');
  expect(evalCompiled(compileLogMessage('plain'))).toBe('plain');
  const compiled = compileLogMessage('hi ${name}');
  expect(evalCompiled(compiled, { name: 'World' })).toBe('hi World');
});

test('L24: compileLogMessage keeps balanced braces inside ${...} (object literals)', () => {
  const compiled = compileLogMessage('x=${ {a:1} }');
  // The object literal must be captured whole — the naive `[^}]+` split
  // truncated it at the inner `}`, leaving `{a:1` and a dangling ` }`.
  expect(compiled).toContain('{a:1}');
  expect(compiled).not.toContain('{a:1)');
  const value = evalCompiled(compiled) as string;
  expect(value).toContain('x=');
  expect(value).toContain('[object Object]');
});

test('L24: compileLogMessage keeps balanced braces in nested template literals', () => {
  const compiled = compileLogMessage('${ `inner ${1+2}` }');
  expect(compiled).toContain('`inner ${1+2}`');
  const value = evalCompiled(compiled) as string;
  expect(value).toBe('inner 3');
});
