import type { ObjectPreview, RemoteObject } from './jsc-types';

const MAX_PREVIEW_PROPS = 5;

/** Stringify a JSC value field: primitives show themselves, anything else falls back. */
function remoteValueText(v: unknown, fallback: string): string {
    switch (typeof v) {
        case 'string':
            return v;
        case 'number':
        case 'boolean':
        case 'bigint':
            return String(v);
        default:
            return fallback;
    }
}

function formatPreview(preview: ObjectPreview | undefined): string {
    if (!preview) return '';
    const bits: string[] = [];
    for (const p of preview.properties ?? []) {
        if (bits.length >= MAX_PREVIEW_PROPS) {
            bits.push('…');
            break;
        }
        bits.push(`${p.name}: ${p.value ?? p.type}`);
    }
    if (preview.entries && preview.entries.length > 0) {
        const shown = preview.entries.slice(0, MAX_PREVIEW_PROPS - bits.length);
        for (const e of shown) {
            const key = remoteValueText(e.key?.value, e.key?.description ?? '');
            const val = remoteValueText(e.value?.value, e.value?.description ?? e.value?.type ?? '');
            bits.push(`${key} => ${val}`);
        }
        if (preview.entries.length > shown.length) bits.push('…');
    }
    return bits.length > 0 ? ` {${bits.join(', ')}}` : '';
}

/**
 * Render a JSC RemoteObject to a readable DAP Variable value string.
 * Primitives show their value (strings quoted), objects/functions their
 * description, with a small preview tail for collections.
 */
export function formatRemoteObject(obj: RemoteObject | undefined): string {
    // Getter-only accessors come back without a `value`; JSC omits it entirely.
    if (obj === undefined) return '(getter)';
    switch (obj.type) {
        case 'undefined':
            return 'undefined';
        case 'string':
            return `'${String(obj.value)}'`;
        case 'boolean':
        case 'number':
        case 'bigint':
            // Unserializable values (bigint, NaN, ±Infinity) carry no `value`;
            // JSC always provides the printable form in `description`.
            return remoteValueText(obj.value, obj.description ?? obj.type);
        case 'symbol':
            return obj.description ?? 'Symbol()';
        case 'function': {
            if (obj.description) {
                const name = /^function\s+([^(\s]*)/.exec(obj.description)?.[1] ?? '';
                return `\u0192 ${name || obj.description}`;
            }
            return `\u0192 ${obj.className ?? 'anonymous'}`;
        }
        case 'object': {
            if (obj.subtype === 'null') return 'null';
            const base = obj.preview?.description ?? obj.className ?? obj.description ?? 'Object';
            return base + formatPreview(obj.preview);
        }
        default:
            return obj.description ?? remoteValueText(obj.value, obj.type);
    }
}
