import { basename } from 'node:path';
import { type RawSourceMap, SourceMapConsumer } from 'source-map-js';

/** 1-based line / 1-based (DAP-style) column. */
export interface GeneratedPosition {
    line: number;
    column: number;
}

export interface OriginalPosition {
    source: string;
    /** 1-based TS/JS line. */
    line: number;
    column: number;
}

function decodeDataUri(uri: string): string {
    const m = /^data:application\/json(?:;([^,]*))?,(.*)$/s.exec(uri);
    if (!m) throw new Error(`invalid source map data URI (${uri.slice(0, 80)})`);
    const meta = m[1] ?? '';
    const body = m[2] ?? '';
    if (/\bbase64\b/.test(meta)) return Buffer.from(body, 'base64').toString('utf8');
    return decodeURIComponent(body);
}

/**
 * A source map for one transpiled module. Bun emits one v3 map per module
 * via `sourceMappingURL` (a base64 data URI), so the selection rule is
 * deterministic: pick the single source, or the one matching the TS path.
 *
 * Coordinate discipline (verified against source-map-js's own parser,
 * lib/source-map-consumer.js): `eachMapping` reports 1-based
 * generated/original lines and 0-based columns; `originalPositionFor` takes a
 * 1-based generated line and returns a 1-based original line.
 *
 * Forward mapping (TS line -> JS line/column) selects the *statement start*:
 * the segment on the original line with the smallest generated column. A
 * GREATEST_LOWER_BOUND lookup at column 0 returns null for indented
 * statements (their first segment sits at column >= 2) and negative columns
 * throw, so the min-column scan is the correct, deterministic rule.
 */
export class SourceMap {
    private consumer: SourceMapConsumer;
    private src: string;

    constructor(rawMap: string, src?: string) {
        this.consumer = new SourceMapConsumer(JSON.parse(rawMap) as RawSourceMap);
        this.src = src ?? '';
    }

    static fromSourceMapURL(dataURI: string, src?: string): SourceMap {
        return new SourceMap(decodeDataUri(dataURI), src);
    }

    private get selectedSource(): string {
        const sources = this.consumer.sources;
        if (sources.length <= 1) return sources[0] ?? '';
        return sources.find((s) => s.endsWith('/' + basename(this.src))) ?? sources[0] ?? '';
    }

    /** Map a 1-based TS line to `{ line, column }` of its generated statement start (1-based). */
    generatedLocation(origLine1: number, _origCol1 = 0): GeneratedPosition | null {
        const source = this.selectedSource;
        const candidates: { gl: number; gc: number }[] = [];
        this.consumer.eachMapping((m) => {
            if (m.source !== source || m.originalLine !== origLine1) return;
            candidates.push({ gl: m.generatedLine, gc: m.generatedColumn });
        });
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.gl - b.gl || a.gc - b.gc);
        const first = candidates[0];
        if (first === undefined) return null;
        return { line: first.gl, column: first.gc + 1 };
    }

    /** Map a 0-based JS line/column back to the original 1-based TS line/column.
     * The source map consumer reports 0-based columns; DAP columns are 1-based,
     * so we report column 1 (the consumer's column is not reliable for TS→JS
     * mappings and 0 reads as "unknown" to many clients). */
    originalLocation(jsLine0: number, jsCol0 = 0): OriginalPosition {
        const result = this.consumer.originalPositionFor({
            line: jsLine0 + 1,
            column: Math.max(0, jsCol0),
            bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
        }) as { source: string | null; line: number | null; column: number | null };
        // source-map-js's .d.ts types `line` as always present, but the runtime
        // returns `line: null` for unmapped positions — keep the guard honest.
        if (result.line === null) return { source: this.selectedSource, line: jsLine0 + 1, column: 1 };
        return { source: result.source ?? this.selectedSource, line: result.line, column: 1 };
    }
}

/** Identity fallback for scripts without a source map. */
export class NoopSourceMap {
    generatedLocation(origLine1: number, _origCol1 = 0): GeneratedPosition {
        return { line: origLine1, column: 1 };
    }

    originalLocation(jsLine0: number, _jsCol0 = 0): OriginalPosition {
        return { source: '<unmapped>', line: jsLine0 + 1, column: 1 };
    }
}

export type AnySourceMap = SourceMap | NoopSourceMap;
