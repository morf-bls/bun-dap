import { castObject, firstBreakpoint, hello, launchReady } from './util/dap-helpers';
import { connectStdio } from './util/framed-client';
import { expect, test } from 'bun:test';

// Regression tests added during the 2026-08 code-review pass. Each test
// reproduces one review issue against the real adapter over stdio and pins
// the fix.

test('L11: deferred setBreakpoints reports "pending script load" message', async () => {
    const client = connectStdio();
    try {
        await launchReady(client, hello);
        // Before configurationDone the --inspect-wait gate holds parsing, so the
        // script is not yet parsed: setBreakpoints takes the deferred branch and
        // must report verified:false with a `pending script load` message (the
        // agent-usage doc already promises this reason; the response must carry
        // it, not leave message undefined).
        const set = await client.send('setBreakpoints', { source: { path: hello }, breakpoints: [{ line: 2 }] });
        const bp = firstBreakpoint(set);
        expect(bp.verified).toBe(false);
        expect(bp.message).toBe('pending script load');
        // Clear the deferred bp and release the gate so the program exits cleanly.
        await client.send('setBreakpoints', { source: { path: hello }, breakpoints: [] });
        await client.send('setExceptionBreakpoints', { filters: [] });
        await client.send('configurationDone', {});
        const exited = await client.waitForEvent('exited', 10_000);
        expect(castObject(exited.body).exitCode).toBe(0);
    } finally {
        client.close();
    }
}, 30_000);
