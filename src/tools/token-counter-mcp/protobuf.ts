import type { TokenDecoder } from "./agent.ts";

export type FieldValue = number | Uint8Array;

/** Usage laid out as a length-delimited protobuf message of varint counters. */
export interface ProtobufUsage {
    /** Field that holds the nested usage message. A missing or non-bytes value counts as 0. */
    messageField: number;
    /** Varint fields inside that message. A missing field counts as 0. */
    counterFields: readonly number[];
}

export function protobufDecoder(usage: ProtobufUsage): TokenDecoder<Uint8Array> {
    return {
        tokens(record) {
            const nested = parseFields(record).get(usage.messageField);
            if (!(nested instanceof Uint8Array)) {
                return 0;
            }
            const message = parseFields(nested);
            let total = 0;
            for (const field of usage.counterFields) {
                total += fieldNum(message, field);
            }
            return total;
        },
    };
}

export function parseFields(data: Uint8Array): Map<number, FieldValue> {
    const fields = new Map<number, FieldValue>();
    let idx = 0;
    while (idx < data.length) {
        const tag = readVarint(data, idx);
        idx = tag.idx;
        const field = Math.trunc(tag.value / 8);
        const wireType = tag.value % 8;
        if (wireType === 0) {
            const value = readVarint(data, idx);
            idx = value.idx;
            fields.set(field, value.value);
        } else if (wireType === 2) {
            const length = readVarint(data, idx);
            idx = length.idx;
            const end = idx + length.value;
            if (end > data.length) {
                throw new Error("truncated length-delimited field");
            }
            fields.set(field, data.subarray(idx, end));
            idx = end;
        } else {
            break;
        }
    }
    return fields;
}

function fieldNum(fields: Map<number, FieldValue>, field: number): number {
    const value = fields.get(field);
    if (value === undefined) {
        return 0;
    }
    if (typeof value !== "number") {
        throw new Error(`field ${field} is not a varint`);
    }
    return value;
}

function readVarint(data: Uint8Array, idx: number): { value: number; idx: number } {
    let value = 0;
    let shift = 0;
    while (true) {
        if (idx >= data.length) {
            throw new Error("truncated varint");
        }
        const byte = data[idx]!;
        idx += 1;
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if ((byte & 0x80) === 0) {
            break;
        }
        if (shift > 49) {
            throw new Error("varint exceeds safe integer range");
        }
    }
    return { value, idx };
}
