import type { DapResponse, connectStdio } from './framed-client';
import { expect } from 'bun:test';
import { resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..', '..');
export const hello = resolve(repoRoot, 'test/fixtures/hello.ts');
export const serverFixture = resolve(repoRoot, 'test/fixtures/server.ts');
export const offsetFixture = resolve(repoRoot, 'test/fixtures/offset.ts');
export const importsFixture = resolve(repoRoot, 'test/fixtures/imports.ts');

export function castObject(body: unknown): Record<string, unknown> {
    if (body && typeof body === 'object') return body as Record<string, unknown>;
    return {};
}

/** Assert a value is non-nullish; test-local replacement for non-null assertions. */
export function must<T>(value: T | null | undefined, message?: string): T {
    if (value === null || value === undefined) throw new Error(message ?? 'must(): value was null or undefined');
    return value;
}

export function firstBreakpoint(resp: DapResponse): Record<string, unknown> {
    const body = castObject(resp.body);
    const bps = body.breakpoints;
    if (Array.isArray(bps) && bps.length > 0 && typeof bps[0] === 'object' && bps[0] !== null) {
        return bps[0] as Record<string, unknown>;
    }
    throw new Error(`setBreakpoints response has no breakpoints: ${JSON.stringify(resp.body)}`);
}

/** The module may not be parsed yet when setBreakpoints arrives: the adapter then
 * answers verified:false ('pending script load') and emits a `breakpoint`
 * changed event once the script parses. Poll the changed event in that case. */
export async function breakpointVerified(
    client: ReturnType<typeof connectStdio>,
    set: DapResponse
): Promise<Record<string, unknown>> {
    let bp = firstBreakpoint(set);
    for (let i = 0; i < 20 && bp.verified !== true; i++) {
        const changed = await client.waitForEvent('breakpoint', 2_000);
        const body = castObject(changed.body);
        const updated = body.breakpoint;
        if (updated && typeof updated === 'object') bp = updated as Record<string, unknown>;
    }
    return bp;
}

/** initialize + capability checks + launch + wait for the `initialized` event. */
export async function launchReady(client: ReturnType<typeof connectStdio>, program: string) {
    const init = await client.send('initialize', { adapterID: 'bun-dap-test', pathFormat: 'path' });
    expect(init.success, init.message).toBe(true);
    const caps = castObject(init.body);
    expect(caps.supportsConfigurationDoneRequest).toBe(true);
    expect(caps.supportsConditionalBreakpoints).toBe(true);
    expect(caps.supportsHitConditionalBreakpoints).toBe(true);
    expect(caps.supportsLogPoints).toBe(true);
    const filters = caps.exceptionBreakpointFilters;
    expect(Array.isArray(filters) && filters.length).toBe(2);

    const launch = await client.send('launch', {
        program,
        cwd: repoRoot,
        stopOnEntry: false,
        noDebug: false,
        runtime: 'bun',
    });
    expect(launch.success, launch.message).toBe(true);

    const initialized = await client.waitForEvent('initialized');
    expect(initialized.event).toBe('initialized');
}

/** Breakpoint + exception filters + configurationDone, then poll for the re-arm
 * event. Order matters: with --inspect-wait the module only parses once the
 * `Inspector.initialized` gate opens (configurationDone), so the `breakpoint`
 * changed event can never arrive before it. */
export async function armBreakpoint(
    client: ReturnType<typeof connectStdio>,
    sourcePath: string,
    line: number,
    extra: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
    const set = await client.send('setBreakpoints', {
        source: { path: sourcePath },
        breakpoints: [{ line, ...extra }],
    });
    const exc = await client.send('setExceptionBreakpoints', { filters: [] });
    expect(exc.success).toBe(true);
    const done = await client.send('configurationDone', {});
    expect(done.success).toBe(true);
    const bp = await breakpointVerified(client, set);
    expect(bp.verified, `breakpoint ${sourcePath}:${line} should verify`).toBe(true);
    expect(bp.line).toBe(line);
    return bp;
}
