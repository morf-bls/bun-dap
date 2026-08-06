import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

// The CLI must answer `-h`/`--help` with usage on stdout and exit 0 — without
// starting a stdio session or a TCP listener. Invalid positional args keep the
// stderr usage + exit 1 path (and now point at --help).

async function runCli(...args: string[]) {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', ...args], {
        cwd: resolve(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
    });
    const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
}

test('--help prints usage to stdout and exits 0', async () => {
    const { code, stdout, stderr } = await runCli('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('Usage');
    expect(stdout).toContain('stdio DAP mode');
    expect(stdout).toContain('<port> [host]');
    expect(stdout).toContain('--help');
    expect(stderr).toBe('');
}, 10_000);

test('-h is an alias for --help', async () => {
    const { code, stdout, stderr } = await runCli('-h');
    expect(code).toBe(0);
    expect(stdout).toContain('Usage');
    expect(stderr).toBe('');
}, 10_000);

test('invalid port still exits 1 with usage on stderr', async () => {
    const { code, stdout, stderr } = await runCli('not-a-port');
    expect(code).toBe(1);
    expect(stderr).toContain('usage:');
    expect(stderr).toContain('--help');
    expect(stdout).toBe('');
}, 10_000);
