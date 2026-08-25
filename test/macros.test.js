import { assert } from "chai";

import { createReader } from "../src/idle.mjs";

const alphaPath = new URL("fixtures/macros/alpha.idle", import.meta.url);
const betaPath = new URL("fixtures/macros/beta.wat", import.meta.url);
const listPath = new URL("../src/list.idle", import.meta.url);

function listToArray(idle, list) {
  const values = [];
  let cursor = list;
  while (idle.kind(cursor) === "cons") {
    values.push(idle.car(cursor));
    cursor = idle.cdr(cursor);
  }
  assert.strictEqual(idle.kind(cursor), "nil");
  return values;
}

describe("WAT macro modules", () => {
  let idle;

  before(async () => {
    idle = await createReader({
      macroModules: { alpha: alphaPath, beta: betaPath },
    });
  });

  it("expands one whole invocation to any datum", () => {
    const [form] = listToArray(idle, idle.readAll("(alpha:second 1 42)"));
    const expanded = idle.macroexpand(form);

    assert.strictEqual(idle.kind(expanded), "integer");
    assert.strictEqual(idle.integerValue(expanded), 42);
  });

  it("constructs lists headed by generated plain symbols", () => {
    const [form] = listToArray(idle, idle.readAll("(alpha:wrap value)"));
    const [head, value] = listToArray(idle, idle.macroexpand(form));

    assert.strictEqual(idle.symbolName(head), "wrap");
    assert.strictEqual(idle.symbolModuleName(head), null);
    assert.strictEqual(idle.symbolName(value), "value");
  });

  it("reaches a fixed point across macros and modules", () => {
    const forms = idle.readAll("(alpha:chain 73) (alpha:to-beta)");
    const wrapper = forms;
    assert.strictEqual(idle.macroexpandAll(forms), wrapper);
    const [first, second] = listToArray(idle, forms);

    assert.strictEqual(idle.integerValue(first), 73);
    assert.strictEqual(idle.integerValue(second), 99);
  });

  it("allows equal local macro names in different modules", () => {
    const [alpha, beta] = listToArray(
      idle,
      idle.macroexpandAll(idle.readAll("(alpha:wrap x) (beta:wrap x)")),
    );

    assert.strictEqual(idle.kind(alpha), "cons");
    assert.strictEqual(idle.symbolName(idle.car(alpha)), "wrap");
    assert.strictEqual(idle.integerValue(beta), 99);
  });

  it("retains mutable state in each instantiated macro module", () => {
    const values = listToArray(
      idle,
      idle.macroexpandAll(idle.readAll("(alpha:count) (alpha:count)")),
    );
    assert.deepEqual(values.map((value) => idle.integerValue(value)), [1, 2]);
  });

  it("mutates nested child slots but returns replacement roots", () => {
    const [outer] = listToArray(idle, idle.readAll("(plain (alpha:second 0 replacement))"));
    const originalOuter = outer;
    const originalTail = idle.cdr(outer);
    const expanded = idle.macroexpand(outer);

    assert.strictEqual(expanded, originalOuter);
    assert.strictEqual(idle.cdr(expanded), originalTail);
    assert.strictEqual(idle.symbolName(idle.car(originalTail)), "replacement");
  });

  it("does not descend beneath plain quote", () => {
    const [quoted] = listToArray(idle, idle.readAll("'(alpha:second 0 8)"));
    const originalDatum = idle.car(idle.cdr(quoted));
    const expanded = idle.macroexpand(quoted);

    assert.strictEqual(expanded, quoted);
    assert.strictEqual(idle.car(idle.cdr(expanded)), originalDatum);
    assert.strictEqual(idle.symbolModuleName(idle.car(originalDatum)), "alpha");
  });

  it("reports unknown qualified heads with macro context", () => {
    const [form] = listToArray(idle, idle.readAll("(missing:nope 1)"));
    let error;
    try {
      idle.macroexpand(form);
    } catch (caught) {
      error = caught;
    }

    assert.strictEqual(error.code, "UNKNOWN_MACRO");
    assert.strictEqual(error.moduleName, "missing");
    assert.strictEqual(error.macroName, "nope");
  });

  it("wraps expander traps with macro context", () => {
    const [form] = listToArray(idle, idle.readAll("(alpha:fail)"));
    let error;
    try {
      idle.macroexpand(form);
    } catch (caught) {
      error = caught;
    }

    assert.strictEqual(error.code, "MACRO_EXPANDER_FAILED");
    assert.strictEqual(error.moduleName, "alpha");
    assert.strictEqual(error.macroName, "fail");
    assert.instanceOf(error.cause, WebAssembly.RuntimeError);
  });

  it("walks deeply nested forms without JavaScript recursion", () => {
    const depth = 10_000;
    const [form] = listToArray(
      idle,
      idle.readAll("(".repeat(depth) + "leaf" + ")".repeat(depth)),
    );

    assert.strictEqual(idle.macroexpand(form), form);
  });

  it("rejects empty and invalid macro modules during loading", async () => {
    const cases = [
      ["empty.wat", "EMPTY_MACRO_MODULE"],
      ["invalid-export.wat", "INVALID_MACRO_EXPORT"],
    ];

    for (const [file, code] of cases) {
      let error;
      try {
        await createReader({
          macroModules: { broken: new URL(`fixtures/macros/${file}`, import.meta.url) },
        });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error.code, code, file);
      assert.strictEqual(error.moduleName, "broken", file);
    }
  });

  it("loads an Idle macro module through the direct reader API", async () => {
    const reader = await createReader({
      macroModules: {
        helper: new URL("fixtures/macros/idle-identity.idle", import.meta.url),
      },
    });
    const [form] = listToArray(reader, reader.readAll("(helper:identity 42)"));
    const expanded = reader.macroexpand(form);
    assert.strictEqual(reader.integerValue(expanded), 42);
  });

  it("lets Idle macro modules intern bare expression strings", async () => {
    const reader = await createReader({
      macroModules: {
        helper: new URL("fixtures/macros/idle-identity.idle", import.meta.url),
      },
    });
    const [form] = listToArray(reader, reader.readAll("(helper:literal-name)"));
    const expanded = reader.macroexpand(form);
    assert.strictEqual(reader.symbolName(expanded), "literal-name");
  });

  it("expands list:list and list:list* with variable arity", async () => {
    const reader = await createReader({ macroModules: { list: listPath } });
    const [emptyForm, valuesForm, oneStarForm, valuesStarForm, emptyStarForm] = listToArray(
      reader,
      reader.readAll(
        "(list:list) (list:list first second third) "
        + "(list:list* tail) (list:list* first second tail) (list:list*)",
      ),
    );
    assert.strictEqual(reader.kind(reader.macroexpand(emptyForm)), "nil");

    let expression = reader.macroexpand(valuesForm);
    for (const expected of ["first", "second", "third"]) {
      const [consHead, value, tail] = listToArray(reader, expression);
      assert.strictEqual(reader.symbolName(consHead), "$cons");
      assert.strictEqual(reader.symbolName(value), expected);
      expression = tail;
    }
    assert.strictEqual(reader.kind(expression), "nil");

    const oneStar = reader.macroexpand(oneStarForm);
    assert.strictEqual(reader.symbolName(oneStar), "tail");
    expression = reader.macroexpand(valuesStarForm);
    for (const expected of ["first", "second"]) {
      const [consHead, value, tail] = listToArray(reader, expression);
      assert.strictEqual(reader.symbolName(consHead), "$cons");
      assert.strictEqual(reader.symbolName(value), expected);
      expression = tail;
    }
    assert.strictEqual(reader.symbolName(expression), "tail");

    let emptyStarError;
    try {
      reader.macroexpand(emptyStarForm);
    } catch (error) {
      emptyStarError = error;
    }
    assert.strictEqual(emptyStarError?.code, "MACRO_EXPANDER_FAILED");
  });

  it("rejects user macro dependencies from Idle macro modules", async () => {
    let error;
    try {
      await createReader({
        macroModules: {
          broken: new URL("fixtures/macros/idle-dependency.idle", import.meta.url),
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert.strictEqual(error?.code, "MACRO_MODULE_COMPILE_FAILED");
    assert.strictEqual(error?.cause?.code, "UNKNOWN_MACRO");
  });
});
