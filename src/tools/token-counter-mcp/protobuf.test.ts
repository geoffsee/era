import { describe, expect, test } from "bun:test";

import { parseFields, protobufDecoder } from "./protobuf.ts";

const decoder = protobufDecoder({ messageField: 9, counterFields: [1, 3, 5, 6] });

describe("protobufDecoder", () => {
    test("sums the named varint counters inside the nested message", () => {
        const nested = bytes([
            ...varintField(1, 10),
            ...varintField(3, 4),
            ...varintField(5, 20),
            ...varintField(6, 1),
        ]);
        const record = bytes(lengthDelimited(9, nested));

        expect(decoder.tokens(record)).toBe(35);
    });

    test("counts a missing nested message as zero", () => {
        expect(decoder.tokens(bytes(varintField(1, 7)))).toBe(0);
    });

    test("counts a missing counter field as zero", () => {
        const record = bytes(lengthDelimited(9, bytes(varintField(1, 8))));

        expect(decoder.tokens(record)).toBe(8);
    });

    test("rejects a counter that is not a varint", () => {
        const record = bytes(lengthDelimited(9, bytes(lengthDelimited(1, bytes([1])))));

        expect(() => decoder.tokens(record)).toThrow("field 1 is not a varint");
    });
});

describe("parseFields", () => {
    test("reads a multi-byte varint", () => {
        expect(parseFields(bytes(varintField(1, 300))).get(1)).toBe(300);
    });

    test("stops on an unsupported wire type", () => {
        const data = bytes([...varintField(1, 4), ...key(2, 5), 0]);

        expect(parseFields(data).get(1)).toBe(4);
        expect(parseFields(data).has(2)).toBe(false);
    });

    test("rejects a truncated varint", () => {
        expect(() => parseFields(bytes([0x80]))).toThrow("truncated varint");
    });

    test("rejects a truncated length-delimited field", () => {
        expect(() => parseFields(bytes([...key(1, 2), 0x02, 0x01]))).toThrow("truncated length-delimited field");
    });

    test("rejects a varint past the safe integer range", () => {
        expect(() => parseFields(bytes([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))).toThrow(
            "varint exceeds safe integer range",
        );
    });
});

function bytes(values: number[]): Uint8Array {
    return Uint8Array.from(values);
}

function key(field: number, wireType: number): number[] {
    return encodeVarint(field * 8 + wireType);
}

function varintField(field: number, value: number): number[] {
    return [...key(field, 0), ...encodeVarint(value)];
}

function lengthDelimited(field: number, payload: Uint8Array): number[] {
    return [...key(field, 2), ...encodeVarint(payload.length), ...payload];
}

function encodeVarint(value: number): number[] {
    const encoded: number[] = [];
    let remaining = value;
    while (remaining > 0x7f) {
        encoded.push((remaining & 0x7f) | 0x80);
        remaining = Math.floor(remaining / 128);
    }
    encoded.push(remaining);
    return encoded;
}
