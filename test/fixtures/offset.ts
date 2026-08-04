// Deliberate comment header (9 lines): the TS line layout diverges from
// Bun's generated JS (comments and blank lines are stripped), so a deferred
// URL-keyed breakpoint armed at line R-1 resolves against generated
// coordinates and lands ~10 lines off. The regression test arms a breakpoint
// on `const sum = left + right;` (TS line 11) BEFORE this module parses; the
// adapter must detect the misalignment and re-arm at the source-mapped
// position, so the pause lands on TS line 11 — not on generated line 11
// (which maps back to `console.log("again: ...")`).
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
