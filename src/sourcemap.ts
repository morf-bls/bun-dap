import { basename } from 'node:path';
import { SourceMapConsumer } from 'source-map-js';

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
    this.consumer = new SourceMapConsumer(JSON.parse(rawMap));
    this.src = src ?? '';
  }

  static fromSourceMapURL(dataURI: string, src?: string): SourceMap {
    return new SourceMap(decodeDataUri(dataURI), src);
  }

  /**
   * Parse the `//# sourceMappingURL=...` trailer from a script's source.
   * Only `data:` URIs link to a usable map in v1; relative/http URLs return null.
   */
  static fromSourceText(scriptSource: string, src?: string): SourceMap | null {
    const m = /\/\/[#@]\s*sourceMappingURL=(\S+)/.exec(scriptSource);
    if (!m) return null;
    const url = m[1]!;
    if (url.startsWith('data:')) return SourceMap.fromSourceMapURL(url, src);
    return null;
  }

  private get selectedSource(): string {
    const sources = this.consumer.sources;
    if (sources.length <= 1) return sources[0] ?? '';
    return sources.find((s) => s.endsWith('/' + basename(this.src))) ?? sources[0]!;
  }

  /** Map a 1-based TS line to `{ line, column }` of its generated statement start (1-based). */
  generatedLocation(origLine1: number, _origCol1 = 0): GeneratedPosition | null {
    const source = this.selectedSource;
    const candidates: Array<{ gl: number; gc: number }> = [];
    this.consumer.eachMapping((m) => {
      if (m.source !== source || m.originalLine !== origLine1) return;
      candidates.push({ gl: m.generatedLine, gc: m.generatedColumn });
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.gl - b.gl || a.gc - b.gc);
    return { line: candidates[0]!.gl, column: candidates[0]!.gc + 1 };
  }

  /** Map a 0-based JS line/column back to the original 1-based TS line (column deliberately 0). */
  originalLocation(jsLine0: number, jsCol0 = 0): OriginalPosition {
    const result = this.consumer.originalPositionFor({
      line: jsLine0 + 1,
      column: Math.max(0, jsCol0),
      bias: SourceMapConsumer.GREATEST_LOWER_BOUND,
    });
    if (result.line === null) return { source: this.selectedSource, line: jsLine0 + 1, column: 0 };
    return { source: result.source, line: result.line, column: 0 };
  }

  originalSources(): string[] {
    return [...this.consumer.sources];
  }
}

/** Identity fallback for scripts without a source map. */
export class NoopSourceMap {
  generatedLocation(origLine1: number, _origCol1 = 0): GeneratedPosition {
    return { line: origLine1, column: 1 };
  }

  originalLocation(jsLine0: number, _jsCol0 = 0): OriginalPosition {
    return { source: '<unmapped>', line: jsLine0 + 1, column: 0 };
  }

  originalSources(): string[] {
    return [];
  }
}

export type AnySourceMap = SourceMap | NoopSourceMap;