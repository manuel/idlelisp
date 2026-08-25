import { assert } from "chai";

import { createReader } from "../src/idle.mjs";

function listToArray(reader, list) {
  const values = [];
  let cursor = list;
  while (reader.kind(cursor) === "cons") {
    values.push(reader.car(cursor));
    cursor = reader.cdr(cursor);
  }
  assert.strictEqual(reader.kind(cursor), "nil");
  return values;
}

describe("minimal Lisp reader", () => {
  let reader;

  before(async () => {
    reader = await createReader();
  });

  it("returns a successful canonical nil list for empty input", () => {
    const empty = reader.readAll("");
    const whitespace = reader.readAll(" \t\r\n\f");

    assert.strictEqual(reader.kind(empty), "nil");
    assert.isTrue(reader.eq(empty, whitespace));
  });

  it("reads multiple top-level integers in source order", () => {
    const values = listToArray(reader, reader.readAll("0 +17 -23 1073741823 -1073741824"));
    assert.deepEqual(values.map((value) => reader.integerValue(value)), [
      0,
      17,
      -23,
      1_073_741_823,
      -1_073_741_824,
    ]);
  });

  it("reads canonical booleans and nil", () => {
    const [truth, falsity, sharpNil, emptyList] = listToArray(
      reader,
      reader.readAll("#t #f #nil ()"),
    );

    assert.strictEqual(reader.booleanValue(truth), true);
    assert.strictEqual(reader.booleanValue(falsity), false);
    assert.strictEqual(reader.kind(sharpNil), "nil");
    assert.isTrue(reader.eq(sharpNil, emptyList));
  });

  it("reads minimal quoted UTF-8 strings and quote or backslash escapes", () => {
    const decoder = new TextDecoder();
    const values = listToArray(
      reader,
      reader.readAll(String.raw`"hello" "hé" "a\\b" "a\"b"`),
    );
    assert.deepEqual(
      values.map((value) => decoder.decode(reader.stringBytes(value))),
      ["hello", "hé", "a\\b", 'a"b'],
    );
  });

  it("interns ASCII and Unicode symbol names across reads", () => {
    const [first, unicode, repeated] = listToArray(
      reader,
      reader.readAll("alpha héλ🙂 alpha"),
    );
    const [later, laterUnicode] = listToArray(reader, reader.readAll("alpha héλ🙂"));

    assert.strictEqual(reader.symbolName(first), "alpha");
    assert.strictEqual(reader.symbolName(unicode), "héλ🙂");
    assert.strictEqual(first, repeated);
    assert.strictEqual(first, later);
    assert.strictEqual(unicode, laterUnicode);
    assert.strictEqual(reader.symbolModuleName(first), null);
  });

  it("interns qualified symbols by plain module symbol and local name", () => {
    const [first, repeated, module, unicode] = listToArray(
      reader,
      reader.readAll("tools:map tools:map tools λib:hé🙂"),
    );
    const [later] = listToArray(reader, reader.readAll("tools:map"));

    assert.strictEqual(first, repeated);
    assert.strictEqual(first, later);
    assert.strictEqual(reader.symbolName(first), "map");
    assert.strictEqual(reader.symbolModuleName(first), "tools");
    assert.strictEqual(reader.symbolName(module), "tools");
    assert.strictEqual(reader.symbolModuleName(module), null);
    assert.strictEqual(reader.symbolName(unicode), "hé🙂");
    assert.strictEqual(reader.symbolModuleName(unicode), "λib");
  });

  it("builds nested proper lists", () => {
    const [outer] = listToArray(reader, reader.readAll("(one (2 #nil) ())"));
    const [one, middle, empty] = listToArray(reader, outer);
    const [two, innerNil] = listToArray(reader, middle);

    assert.strictEqual(reader.symbolName(one), "one");
    assert.strictEqual(reader.integerValue(two), 2);
    assert.strictEqual(reader.kind(innerNil), "nil");
    assert.strictEqual(reader.kind(empty), "nil");
  });

  it("expands quote prefixes with the canonical quote symbol", () => {
    const [quoted, twice, quoteToken] = listToArray(
      reader,
      reader.readAll("'x ''y quote"),
    );
    const [quote, x] = listToArray(reader, quoted);
    const [outerQuote, inner] = listToArray(reader, twice);
    const [innerQuote, y] = listToArray(reader, inner);

    assert.strictEqual(quote, quoteToken);
    assert.strictEqual(outerQuote, quoteToken);
    assert.strictEqual(innerQuote, quoteToken);
    assert.strictEqual(reader.symbolName(x), "x");
    assert.strictEqual(reader.symbolName(y), "y");
  });

  it("mutates cons fields without changing cons identity", () => {
    const [pair, replacement] = listToArray(reader, reader.readAll("(1 2) changed"));
    const original = pair;
    const tail = reader.cdr(pair);

    assert.strictEqual(reader.integerValue(reader.car(pair)), 1);
    assert.strictEqual(reader.setCar(pair, replacement), original);
    assert.strictEqual(reader.car(pair), replacement);
    assert.strictEqual(reader.setCdr(pair, reader.readAll("")), original);
    assert.strictEqual(reader.kind(reader.cdr(pair)), "nil");
    assert.strictEqual(reader.integerValue(reader.car(tail)), 2);
  });

  it("hashes nil, symbols, and conses by their intended identities", () => {
    const [first, second, symbol] = listToArray(reader, reader.readAll("(1) (1) identity"));
    const nil = reader.readAll("");
    const firstHash = reader.hash(first);
    const symbolHash = reader.hash(symbol);

    assert.isTrue(reader.isHashable(nil));
    assert.isTrue(reader.isHashable(first));
    assert.isTrue(reader.isHashable(symbol));
    assert.notStrictEqual(reader.hash(first), reader.hash(second));
    reader.setCar(first, symbol);
    assert.strictEqual(reader.hash(first), firstHash);
    assert.strictEqual(reader.hash(symbol), symbolHash);
    assert.strictEqual(reader.hash(nil), reader.hash(reader.readAll("")));
  });

  it("reports stable syntax codes and UTF-8 byte offsets", () => {
    const cases = [
      [")", "UNEXPECTED_CLOSE", 0],
      ["(", "UNTERMINATED_LIST", 1],
      ["'", "MISSING_QUOTED_DATUM", 1],
      ["#maybe", "UNKNOWN_SHARP_SYNTAX", 0],
      ["1073741824", "INTEGER_OVERFLOW", 0],
      ["-1073741825", "INTEGER_OVERFLOW", 0],
      [".", "DOTTED_LIST_UNSUPPORTED", 0],
      ["hé )", "UNEXPECTED_CLOSE", 4],
      ["\"", "UNTERMINATED_STRING", 0],
      [String.raw`"bad\q"`, "INVALID_STRING_ESCAPE", 4],
      ["name;rest", "READER_SYNTAX_UNSUPPORTED", 4],
      [":name", "INVALID_QUALIFIED_SYMBOL", 0],
      ["module:", "INVALID_QUALIFIED_SYMBOL", 0],
      ["one:two:three", "INVALID_QUALIFIED_SYMBOL", 0],
    ];

    for (const [source, code, byteOffset] of cases) {
      let error;
      try {
        reader.readAll(source);
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, SyntaxError, source);
      assert.strictEqual(error.code, code, source);
      assert.strictEqual(error.byteOffset, byteOffset, source);
    }
  });

  it("parses ten thousand nested lists without parser recursion", () => {
    const depth = 10_000;
    const [form] = listToArray(reader, reader.readAll("(".repeat(depth) + ")".repeat(depth)));
    let cursor = form;
    for (let index = 1; index < depth; index += 1) {
      assert.strictEqual(reader.kind(cursor), "cons");
      cursor = reader.car(cursor);
    }
    assert.strictEqual(reader.kind(cursor), "nil");
  });

  it("retains values while staging memory grows beyond one page", () => {
    const [retained] = listToArray(reader, reader.readAll("retained"));
    const longSource = `${" ".repeat(70_000)}retained`;
    const [again] = listToArray(reader, reader.readAll(longSource));

    assert.strictEqual(retained, again);
    assert.strictEqual(reader.symbolName(retained), "retained");
  });

  it("resolves hundreds of interned names in reverse order", () => {
    const names = Array.from({ length: 300 }, (_, index) => `name-${index}`);
    const first = listToArray(reader, reader.readAll(names.join(" ")));
    const reversed = listToArray(reader, reader.readAll(names.toReversed().join(" ")));

    reversed.forEach((value, index) => {
      assert.strictEqual(value, first[first.length - index - 1]);
    });
  });

  it("rejects invalid facade operations", () => {
    const [integer, symbol] = listToArray(reader, reader.readAll("1 name"));

    assert.throws(() => reader.readAll(1), TypeError);
    assert.throws(() => reader.car(integer), TypeError);
    assert.throws(() => reader.integerValue(symbol), TypeError);
    assert.throws(() => reader.symbolName(integer), TypeError);
    assert.throws(() => reader.symbolModuleName(integer), TypeError);
  });
});
