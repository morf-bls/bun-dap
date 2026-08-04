// Deliberate comment header (9 lines): the TS line layout diverges from
// Bun's generated JS (comments and blank lines are stripped). Divergence like
// this used to break deferred breakpoints: an arm at `bp.line - 1` resolves
// against GENERATED coordinates and lands ~10 lines off. The regression test
// arms a breakpoint on `return sum;` (TS line 13) BEFORE this module parses;
// the adapter defers the arm to scriptParsed, decodes this module's inline
// map synchronously, and binds at the mapped generated position — so the
// pause lands on TS line 13, on both calls to add().
// line 9

function add(left: number, right: number): number {
  const sum = left + right;
  return sum;
}

function main(): void {
  const first = add(1, 2);
  const second = add(3, 4);
  const total = first + second;
  console.log(`total: ${total}`);
  console.log(`total*2: ${total * 2}`);
  console.log(`again: ${total}`);
  console.log(`final: ${total}`);
}

main();
