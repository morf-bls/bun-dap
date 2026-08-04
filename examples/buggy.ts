// Deliberately buggy program for manual bun-dap testing.
//
// Run:   bun run examples/buggy.ts
// Every function below misbehaves on purpose. Stepping through this file with
// bun-dap should show wrong numbers and an intentional crash at the end
// (the process exits with code 1).
//
// Manual-test checklist:
//   - breakpoints on the TS lines below (source-mapped: DAP lines are TS lines)
//   - the multi-line header comment above is deliberate: it offsets the TS
//     lines from the generated JS. A breakpoint set BEFORE the script loads
//     (the normal launch flow) lands ~21 lines off — a known bun-dap bug (see
//     the skipped `offset` test in test/adapter.test.ts). A breakpoint set
//     AFTER a pause (stopOnEntry, or after the first stop) lands correctly via
//     the source map.
//   - step next / stepIn / stepOut across the functions
//   - locals — JSC splits parameters into a Closure scope and block
//     variables into Local; makeCounter's `count` lives in a Closure scope
//   - conditional / hit-conditional / logpoint breakpoints
//   - exception breakpoints (all / uncaught) — the end-of-file throw
//   - evaluate while paused, e.g. "subtotal.toFixed(2)" inside applyDiscount

function applyDiscount(price: number, quantity: number): number {
  const rate = 0.2; // 20% off
  const subtotal = price * quantity;
  return subtotal * rate; // BUG: should be subtotal * (1 - rate)
}

function computeAverage(values: number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length + 1; // BUG: +1 lands outside the division
}

function fibonacci(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i <= n; i++) {
    [a, b] = [b, a + b];
  }
  return a; // BUG: loop runs one step too far (i <= n instead of i < n)
}

function makeCounter(start: number) {
  let count = start; // closure variable: lands in a Closure scope, not Local
  return function step(delta: number): number {
    count -= delta; // BUG: sign flipped; should be +=
    return count;
  };
}

const prices = [19.99, 5.5, 120, 0.99];
const quantities = [2, 4, 1, 3];

const totals = prices.map((price, i) => applyDiscount(price, quantities[i]!));
const average = computeAverage(totals);
const fib = fibonacci(10);
const counter = makeCounter(average);

console.log(`totals:  ${totals.join(", ")}`);
console.log(`average: ${average.toFixed(2)}  (bug: +1 after the division)`);
console.log(`fib(10): ${fib}  (bug: should be 55)`);
console.log(`counter: ${counter(2)}, ${counter(5)}  (bug: decrements instead of incrementing)`);

throw new Error("intentional crash — exercise exception breakpoints (all/uncaught)");
