import { NoopSourceMap, SourceMap } from '../src/sourcemap';
import { getAvailablePort } from '../src/util/port';
import { must } from './util/dap-helpers';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = resolve(import.meta.dir, 'fixtures/sample.ts');

function buildInlineMap(): { js: string; mapUrl: string } {
    const dir = mkdtempSync(join(tmpdir(), 'bun-dap-sm-'));
    const outfile = join(dir, 'sample.js');
    const proc = Bun.spawnSync(['bun', 'build', fixture, '--sourcemap=inline', '--outfile', outfile]);
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    const js = readFileSync(outfile, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    const m = /\/\/[#@]\s*sourceMappingURL=(\S+)/.exec(js);
    expect(m, 'bundled js must carry an inline sourceMappingURL').not.toBeNull();
    const mapUrl = m?.[1];
    if (mapUrl === undefined) throw new Error('missing sourceMappingURL capture');
    return { js, mapUrl };
}

describe('port helper', () => {
    test('getAvailablePort returns a free localhost port', async () => {
        const port = await getAvailablePort();
        expect(typeof port).toBe('number');
        expect(port).toBeGreaterThan(0);
        const net = await import('node:net');
        const probe = net.createConnection({ host: '127.0.0.1', port });
        const refused = await new Promise<boolean>((res) => {
            probe.once('connect', () => {
                res(false);
            });
            probe.once('error', (e: NodeJS.ErrnoException) => {
                res(e.code === 'ECONNREFUSED');
            });
        });
        probe.destroy();
        expect(refused).toBe(true);
    });
});

describe('SourceMap (real bun build, inline map)', () => {
    const { mapUrl } = buildInlineMap();

    test('fromSourceMapURL parses and round-trips the if-line', () => {
        const map = SourceMap.fromSourceMapURL(mapUrl, fixture);
        // TS line 2 = `if (!cmd.startsWith('rm')) return 'allow';`
        const gen = map.generatedLocation(2, 0);
        expect(gen).not.toBeNull();
        const back = map.originalLocation(must(gen).line - 1, must(gen).column - 1);
        expect(back.line).toBe(2);
        expect(back.source).toContain('sample.ts');
    });

    test('generatedLocation for unmapped line returns null', () => {
        const map = SourceMap.fromSourceMapURL(mapUrl, fixture);
        expect(map.generatedLocation(9999, 0)).toBeNull();
    });
});

describe('NoopSourceMap', () => {
    test('identity forward mapping and <unmapped> backward', () => {
        const map = new NoopSourceMap();
        expect(map.generatedLocation(5, 0)).toEqual({ line: 5, column: 1 });
        const orig = map.originalLocation(3, 0);
        expect(orig.source).toBe('<unmapped>');
        expect(orig.line).toBe(4);
        expect(orig.column).toBe(1);
    });
});
