import { getAvailablePort } from '../src/util/port';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

// The CLI must warn on stderr when binding a non-loopback host, and stay
// quiet for loopback. Spawn the real CLI (TCP server mode) and read stderr.

/** Spawn `bun run src/cli.ts <port> <host>`, collect stderr until a marker, then kill. */
async function cliStderr(host: string, wantWarning: boolean): Promise<string> {
    const port = await getAvailablePort();
    const child = Bun.spawn(['bun', 'run', 'src/cli.ts', String(port), host], {
        cwd: resolve(import.meta.dir, '..'),
        stdout: 'ignore',
        stderr: 'pipe',
        stdin: 'ignore',
    });
    let stderr = '';
    const deadline = setTimeout(() => {
        try {
            child.kill();
        } catch {
            /* already gone */
        }
    }, 5_000);
    try {
        for await (const chunk of child.stderr as AsyncIterable<Uint8Array>) {
            stderr += Buffer.from(chunk).toString('utf8');
            // The "listening" line is the last thing the CLI writes; once we see it
            // (and the warning, if expected) we have what we need.
            if (stderr.includes('listening')) break;
        }
    } finally {
        clearTimeout(deadline);
        try {
            child.kill();
        } catch {
            /* already gone */
        }
    }
    // Sanity: the server should have bound. Avoid unused-var lint.
    void wantWarning;
    return stderr;
}

test('non-loopback host warns on stderr about the RCE surface', async () => {
    const stderr = await cliStderr('0.0.0.0', true);
    expect(stderr, 'warning present').toContain('warning');
    expect(stderr, 'names the host').toContain('0.0.0.0');
    expect(stderr, 'mentions evaluate/RCE').toMatch(/evaluate|RCE/);
    expect(stderr, 'still listens').toContain('listening');
}, 10_000);

test('loopback host (127.0.0.1) emits no warning', async () => {
    const stderr = await cliStderr('127.0.0.1', false);
    expect(stderr, 'no warning for loopback').not.toContain('warning');
    expect(stderr, 'still listens').toContain('listening');
}, 10_000);
