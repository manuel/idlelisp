import { readFile } from "node:fs/promises";

import { assert } from "chai";

const wasmPath = new URL("../build/objects.wasm", import.meta.url);

const encode = new TextEncoder();

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return hash | 0;
}

describe("Wasm-GC objects", () => {
  let wasm;

  before(async () => {
    const { instance } = await WebAssembly.instantiate(await readFile(wasmPath));
    wasm = instance.exports;
  });

  function makeString(bytes) {
    const value = wasm.new_str(bytes.length);
    bytes.forEach((byte, index) => wasm.str_init_byte(value, index, byte));
    return value;
  }

  function makeList(...values) {
    let result = wasm.abi_nil();
    for (let index = values.length - 1; index >= 0; index -= 1) {
      result = wasm.abi_cons(values[index], result);
    }
    return result;
  }

  function listValues(value) {
    const result = [];
    let cursor = value;
    while (!wasm.abi_is_nil(cursor)) {
      result.push(wasm.abi_integer_value(wasm.abi_car(cursor)));
      cursor = wasm.abi_cdr(cursor);
    }
    return result;
  }

  it("stores and compares reference-valued type tags", () => {
    const firstTag = wasm.new_tag();
    const secondTag = wasm.new_tag();
    const object = wasm.new_obj(firstTag);

    assert.strictEqual(wasm.obj_tag(object), firstTag);
    assert.strictEqual(wasm.has_tag(object, firstTag), 1);
    assert.strictEqual(wasm.has_tag(object, secondTag), 0);
  });

  it("uses reference identity for ordinary objects", () => {
    const tag = wasm.new_tag();
    const first = wasm.new_obj(tag);
    const second = wasm.new_obj(tag);

    assert.strictEqual(wasm.is_equal(first, first), 1);
    assert.strictEqual(wasm.is_equal(first, second), 0);
    assert.strictEqual(wasm.is_obj(first), 1);
    assert.strictEqual(wasm.is_idobj(first), 0);
  });

  it("allocates stable 32-bit hashes without using them as equality", () => {
    const tag = wasm.new_tag();
    const first = wasm.new_idobj(tag);
    const second = wasm.new_idobj(tag);
    const firstHash = wasm.idobj_hash(first);

    assert.strictEqual(wasm.idobj_hash(first), firstHash);
    assert.notStrictEqual(firstHash, wasm.idobj_hash(second));
    assert.strictEqual(wasm.is_equal(first, first), 1);
    assert.strictEqual(wasm.is_equal(first, second), 0);
    assert.strictEqual(wasm.is_obj(first), 1);
    assert.strictEqual(wasm.is_idobj(first), 1);
  });

  it("supports consumer-defined object and identity-object subtypes", () => {
    const tag = wasm.new_tag();
    const object = wasm.new_payload_obj(tag, 41);
    const identityObject = wasm.new_payload_idobj(tag, 42);

    assert.strictEqual(wasm.payload_obj_value(object), 41);
    assert.strictEqual(wasm.payload_idobj_value(identityObject), 42);
    assert.strictEqual(wasm.has_tag(object, tag), 1);
    assert.strictEqual(wasm.has_tag(identityObject, tag), 1);
    assert.strictEqual(wasm.is_obj(object), 1);
    assert.strictEqual(wasm.is_obj(identityObject), 1);
    assert.strictEqual(wasm.is_idobj(object), 0);
    assert.strictEqual(wasm.is_idobj(identityObject), 1);
  });

  it("leaves room for non-object immediates and value-object subtypes", () => {
    const tag = wasm.new_tag();
    const stringish = wasm.new_stringish_obj(tag, 0x12345678);

    assert.strictEqual(wasm.is_obj(stringish), 1);
    assert.strictEqual(wasm.is_idobj(stringish), 0);
    assert.strictEqual(wasm.is_i31_obj(17), 0);
    assert.strictEqual(wasm.is_i31_idobj(17), 0);
  });

  it("measures proper lists and rejects improper tails", () => {
    const empty = wasm.abi_nil();
    const proper = makeList(wasm.abi_integer(1), wasm.abi_integer(2), wasm.abi_integer(3));
    const improper = wasm.abi_cons(wasm.abi_integer(1), wasm.abi_integer(2));

    assert.strictEqual(wasm.abi_list_length(empty), 0);
    assert.strictEqual(wasm.abi_list_length(proper), 3);
    assert.throws(() => wasm.abi_list_length(improper), WebAssembly.RuntimeError);
  });

  it("reverse-prepends proper lists onto arbitrary tails", () => {
    const tail = makeList(wasm.abi_integer(9));
    const values = makeList(wasm.abi_integer(1), wasm.abi_integer(2), wasm.abi_integer(3));
    const improper = wasm.abi_cons(wasm.abi_integer(1), wasm.abi_integer(2));

    assert.strictEqual(wasm.abi_list_reverse_prepend(wasm.abi_nil(), tail), tail);
    assert.deepEqual(listValues(wasm.abi_list_reverse_prepend(values, tail)), [3, 2, 1, 9]);
    assert.throws(
      () => wasm.abi_list_reverse_prepend(improper, tail),
      WebAssembly.RuntimeError,
    );
  });

  it("stores UTF-8 directly in plain packed byte arrays", () => {
    const cases = [
      new Uint8Array(),
      encode.encode("idle"),
      new Uint8Array([0x61, 0, 0x62]),
      encode.encode("héλ🙂"),
    ];

    for (const bytes of cases) {
      const value = makeString(bytes);

      assert.strictEqual(wasm.is_str(value), 1);
      assert.strictEqual(wasm.is_obj(value), 0);
      bytes.forEach((byte, index) => {
        assert.strictEqual(wasm.str_byte_at(value, index), byte);
      });
      assert.strictEqual(wasm.str_hash(value), fnv1a(bytes));
      assert.strictEqual(wasm.hash(value), fnv1a(bytes));
    }
  });

  it("compares separately allocated strings by byte contents", () => {
    const bytes = encode.encode("same contents");
    const first = makeString(bytes);
    const second = makeString(bytes);
    const different = makeString(encode.encode("different"));

    assert.notStrictEqual(first, second);
    assert.strictEqual(wasm.is_equal_str(first, second), 1);
    assert.strictEqual(wasm.is_equal(first, second), 1);
    assert.strictEqual(wasm.is_equal(first, different), 0);
    assert.strictEqual(wasm.str_hash(first), wasm.str_hash(second));
  });

  it("treats every structurally equivalent packed byte array as a string", () => {
    const value = wasm.new_foreign_bytes(3);
    wasm.str_init_byte(value, 0, 0x61);
    wasm.str_init_byte(value, 1, 0x62);
    wasm.str_init_byte(value, 2, 0x63);

    assert.strictEqual(wasm.is_str(value), 1);
    assert.strictEqual(wasm.str_hash(value), fnv1a(encode.encode("abc")));
  });

  it("uses canonical tagged objects for booleans", () => {
    const falseValue = wasm.i32_to_bool(0);
    const trueValue = wasm.i32_to_bool(1);

    assert.strictEqual(wasm.i32_to_bool(0), falseValue);
    assert.strictEqual(wasm.i32_to_bool(-12), trueValue);
    assert.strictEqual(wasm.is_bool(falseValue), 1);
    assert.strictEqual(wasm.is_bool(trueValue), 1);
    assert.strictEqual(wasm.bool_to_i32(falseValue), 0);
    assert.strictEqual(wasm.bool_to_i32(trueValue), 1);
    assert.strictEqual(wasm.is_obj(falseValue), 1);
    assert.strictEqual(wasm.is_obj(trueValue), 1);
    assert.strictEqual(wasm.is_idobj(falseValue), 0);
    assert.strictEqual(wasm.obj_tag(falseValue), wasm.obj_tag(trueValue));
    assert.strictEqual(wasm.has_tag(trueValue, wasm.obj_tag(falseValue)), 1);
    assert.strictEqual(wasm.is_equal(falseValue, wasm.i32_to_bool(0)), 1);
    assert.strictEqual(wasm.is_equal(falseValue, trueValue), 0);
  });

  it("hashes immediate integers, strings, booleans, and identity objects", () => {
    const tag = wasm.new_tag();
    const identityObject = wasm.new_idobj(tag);
    const string = makeString(encode.encode("hashable"));
    const falseValue = wasm.i32_to_bool(0);
    const trueValue = wasm.i32_to_bool(1);

    assert.strictEqual(wasm.is_hashable_i31(0), 1);
    assert.strictEqual(wasm.is_hashable_i31(1073741823), 1);
    assert.strictEqual(wasm.is_hashable_i31(-1073741824), 1);
    assert.strictEqual(wasm.is_equal_i31(27, 27), 1);
    assert.strictEqual(wasm.is_equal_i31(27, -27), 0);
    assert.strictEqual(wasm.hash_i31(27), wasm.hash_i31(27));
    assert.notStrictEqual(wasm.hash_i31(27), wasm.hash_i31(-27));
    assert.strictEqual(wasm.is_hashable(string), 1);
    assert.strictEqual(wasm.is_hashable(falseValue), 1);
    assert.strictEqual(wasm.is_hashable(trueValue), 1);
    assert.strictEqual(wasm.is_hashable(identityObject), 1);
    assert.strictEqual(wasm.hash(identityObject), wasm.idobj_hash(identityObject));
    assert.notStrictEqual(wasm.hash(falseValue), wasm.hash(trueValue));
  });

  it("rejects unsupported ordinary objects from generic hashing", () => {
    const object = wasm.new_obj(wasm.new_tag());

    assert.strictEqual(wasm.is_hashable(object), 0);
    assert.throws(() => wasm.hash(object), WebAssembly.RuntimeError);
  });

  it("stores AOT class instances in fixed single-inheritance structs", () => {
    const counter = wasm.new_counter(17);
    const offsetCounter = wasm.new_offset_counter(17, 5);

    assert.strictEqual(wasm.is_obj(counter), 1);
    assert.strictEqual(wasm.is_obj(offsetCounter), 1);
    assert.strictEqual(wasm.is_idobj(counter), 0);
    assert.strictEqual(wasm.is_counter_value(counter), 1);
    assert.strictEqual(wasm.is_counter_value(offsetCounter), 1);
    assert.strictEqual(wasm.is_offset_counter_value(counter), 0);
    assert.strictEqual(wasm.is_offset_counter_value(offsetCounter), 1);
    assert.notStrictEqual(wasm.obj_tag(counter), wasm.obj_tag(offsetCounter));
  });

  it("dispatches inherited, overridden, and subclass virtual methods", () => {
    const counter = wasm.new_counter(17);
    const offsetCounter = wasm.new_offset_counter(17, 5);

    assert.strictEqual(wasm.call_counter_read(counter), 17);
    assert.strictEqual(wasm.call_counter_read(offsetCounter), 22);
    assert.strictEqual(wasm.call_offset_counter_offset(offsetCounter), 5);
    assert.strictEqual(wasm.is_equal(counter, counter), 1);
    assert.strictEqual(wasm.is_equal(counter, wasm.new_counter(17)), 0);
    assert.strictEqual(wasm.is_hashable(counter), 0);
  });

  it("supports direct and recursive virtual tail calls", () => {
    const counter = wasm.new_counter(9);
    const offsetCounter = wasm.new_offset_counter(9, 4);

    assert.strictEqual(wasm.tail_call_counter_read(counter), 9);
    assert.strictEqual(wasm.tail_call_counter_read(offsetCounter), 13);
    assert.strictEqual(wasm.tail_call_counter_read_exact(counter), 9);
    assert.strictEqual(wasm.call_counter_countdown(counter, 100_000), 9);
    assert.strictEqual(wasm.call_counter_countdown(offsetCounter, 100_000), 13);
  });
});
