import { test, expect } from 'bun:test';
import { formatRemoteObject } from '../src/inspector/preview';
import type { PropertyDescriptor } from '../src/inspector/jsc-types';

test('formatRemoteObject handles undefined without throwing', () => {
  // JSC omits `value` for getter-only accessors; the adapter must not crash.
  expect(() => formatRemoteObject(undefined)).not.toThrow();
  expect(formatRemoteObject(undefined)).toBe('(getter)');
});

test('formatRemoteObject tolerates a value-less PropertyDescriptor', () => {
  const descriptor: PropertyDescriptor = { name: 'getterOnly' };
  expect(() => formatRemoteObject(descriptor.value)).not.toThrow();
  expect(formatRemoteObject(descriptor.value)).toBe('(getter)');
});

test('formatRemoteObject renders undefined primitives', () => {
  expect(formatRemoteObject({ type: 'undefined' })).toBe('undefined');
});

test('formatRemoteObject renders bigint from description when value is absent', () => {
  expect(formatRemoteObject({ type: 'bigint', description: '123n' })).toBe('123n');
  expect(formatRemoteObject({ type: 'bigint', value: undefined, description: '9999999999999999999999999n' })).toBe(
    '9999999999999999999999999n',
  );
});

test('formatRemoteObject renders NaN and Infinity from description', () => {
  expect(formatRemoteObject({ type: 'number', value: null, description: 'NaN' })).toBe('NaN');
  expect(formatRemoteObject({ type: 'number', value: null, description: 'Infinity' })).toBe('Infinity');
});

test('formatRemoteObject still renders plain numbers', () => {
  expect(formatRemoteObject({ type: 'number', value: 42, description: '42' })).toBe('42');
});