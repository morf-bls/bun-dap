// Fixture for the module-with-imports deferred-breakpoint shape (the nvim
// attach failure): importing node:path makes the process's first executed
// statement live in a builtin initializer, BEFORE this module parses — so a
// global entry brake is consumed too early, and this synchronous body
// outruns a deferred bp arm (JSC cannot process the arm RPC while sync JS
// monopolizes the debuggee's event loop) unless the per-source line-0
// placeholder brake pauses the module at its first statement. Without that
// brake the bp verifies only after the program has already exited.
import nodePath from 'node:path';

function compute(i: number): number {
    const p = nodePath.join('/tmp', `case-${i}`);
    return p.length + i;
}

let total = 0;
for (let i = 0; i < 100; i++) {
    total += compute(i);
}

console.log('imports fixture done', total);
