import { assert } from "chai";

import { compileToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";

const program = `
  (type $token (struct (field $number i32)))
  (global $key-a (ref $token) (struct.new $token (i32.const 1)))
  (global $key-b (ref $token) (struct.new $token (i32.const 2)))
  (global $value-a (ref $token) (struct.new $token (i32.const 11)))
  (global $value-b (ref $token) (struct.new $token (i32.const 22)))

  (func $key-a (result (ref eq)) (global.get $key-a))

  (func $empty-has (result i32)
    (dynamic:has
      (ref.null $dynamic.binding)
      (global.get $key-a)))

  (func $fallback-is-value-a (result i32)
    (ref.eq
      (dynamic:ref
        (ref.null $dynamic.binding)
        (global.get $key-a)
        (global.get $value-a))
      (global.get $value-a)))

  (func $shadowing-is-persistent (result i32)
    (local $first (ref $dynamic.binding))
    (local $second (ref $dynamic.binding))
    (local.set $first
      (dynamic:bind
        (ref.null $dynamic.binding)
        (global.get $key-a)
        (global.get $value-a)))
    (local.set $second
      (dynamic:bind
        (local.get $first)
        (global.get $key-a)
        (global.get $value-b)))
    (i32.and
      (ref.eq
        (dynamic:ref (local.get $first) (global.get $key-a))
        (global.get $value-a))
      (ref.eq
        (dynamic:ref (local.get $second) (global.get $key-a))
        (global.get $value-b))))

  (func $distinct-reference-keys (result i32)
    (local $dynamic (ref $dynamic.binding))
    (local.set $dynamic
      (dynamic:bind
        (ref.null $dynamic.binding)
        (global.get $key-a)
        (global.get $value-a)))
    (i32.and
      (dynamic:has (local.get $dynamic) (global.get $key-a))
      (i32.eqz
        (dynamic:has (local.get $dynamic) (global.get $key-b)))))

  (func $equal-i31-keys (result i32)
    (local $dynamic (ref $dynamic.binding))
    (local.set $dynamic
      (dynamic:bind
        (ref.null $dynamic.binding)
        (ref.i31 (i32.const 7))
        (global.get $value-a)))
    (ref.eq
      (dynamic:ref (local.get $dynamic) (ref.i31 (i32.const 7)))
      (global.get $value-a)))

  (func $make-environment (result (ref $dynamic.binding))
    (dynamic:bind
      (ref.null $dynamic.binding)
      (global.get $key-a)
      (global.get $value-a)))

  (func $extend-environment
    (param $dynamic (ref null $dynamic.binding))
    (result (ref $dynamic.binding))
    (dynamic:bind
      (local.get $dynamic)
      (global.get $key-b)
      (global.get $value-b)))

  (func $has-key-a
    (param $dynamic (ref null $dynamic.binding))
    (result i32)
    (dynamic:has (local.get $dynamic) (global.get $key-a)))

  (func $has-key-b
    (param $dynamic (ref null $dynamic.binding))
    (result i32)
    (dynamic:has (local.get $dynamic) (global.get $key-b)))

  (func $missing
    (param $dynamic (ref null $dynamic.binding))
    (result (ref eq))
    (dynamic:ref (local.get $dynamic) (global.get $key-a)))

  (func $tail-loop
    (param $dynamic (ref null $dynamic.binding))
    (param $remaining i32)
    (result i32)
    (if (result i32)
      (i32.eqz (local.get $remaining))
      (then
        (dynamic:has (local.get $dynamic) (global.get $key-a)))
      (else
        (return_call $tail-loop
          (dynamic:bind
            (local.get $dynamic)
            (global.get $key-a)
            (ref.i31 (local.get $remaining)))
          (i32.sub (local.get $remaining) (i32.const 1))))))

  (defclass DynamicReader)

  (defgeneric $dynamic-reader-has-key-a
    ((reader DynamicReader) (dynamic (ref null $dynamic.binding)) i32))

  (defmethod $dynamic-reader-has-key-a
    ((reader DynamicReader) (dynamic (ref null $dynamic.binding)) i32)
    (dynamic:has (local.get $dynamic) (global.get $key-a)))

  (export-new DynamicReader)
  (export-func dynamic-reader-has-key-a)
  (export-func key-a)
  (export-func empty-has)
  (export-func fallback-is-value-a)
  (export-func shadowing-is-persistent)
  (export-func distinct-reference-keys)
  (export-func equal-i31-keys)
  (export-func make-environment)
  (export-func extend-environment)
  (export-func has-key-a)
  (export-func has-key-b)
  (export-func missing)
  (export-func tail-loop)
`;

async function compileBinary(source, transformWat = (wat) => wat) {
  const wat = transformWat(
    await compileToWat({ sources: [{ name: "dynamic.idle", text: `(module\n${source}\n)` }] }),
  );
  const { default: binaryen } = await import("binaryen");
  const module = binaryen.parseText(wat);
  try {
    module.setFeatures(idleWasmFeatures(binaryen));
    assert.isOk(module.validate());
    return { wat, binary: module.emitBinary() };
  } finally {
    module.dispose();
  }
}

describe("explicit dynamic environments", () => {
  let wat;
  let exports;

  before(async () => {
    const compiled = await compileBinary(program);
    wat = compiled.wat;
    ({ instance: { exports } } = await WebAssembly.instantiate(compiled.binary));
  });

  it("expands every dynamic form and injects its runtime only when used", async () => {
    assert.include(wat, "(type $dynamic.binding");
    assert.include(wat, '(export "dynamic-unbound"');
    assert.include(wat, "(call $dynamic.bind");
    assert.include(wat, "(call $dynamic.ref");
    assert.include(wat, "(call $dynamic.ref-or");
    assert.include(wat, "(call $dynamic.has");

    const plain = await compileToWat({
      sources: [{ name: "plain.idle", text: "(module (func $plain))" }],
    });
    assert.notInclude(plain, "$dynamic.binding");
    assert.notInclude(plain, "dynamic-unbound");
  });

  it("supports absence, eager fallback, shadowing, and immutable prefixes", () => {
    assert.strictEqual(exports["empty-has"](), 0);
    assert.strictEqual(exports["fallback-is-value-a"](), 1);
    assert.strictEqual(exports["shadowing-is-persistent"](), 1);

    const first = exports["make-environment"]();
    const second = exports["extend-environment"](first);
    assert.strictEqual(exports["has-key-a"](first), 1);
    assert.strictEqual(exports["has-key-b"](first), 0);
    assert.strictEqual(exports["has-key-a"](second), 1);
    assert.strictEqual(exports["has-key-b"](second), 1);
  });

  it("compares reference keys by identity and immediate i31 keys by value", () => {
    assert.strictEqual(exports["distinct-reference-keys"](), 1);
    assert.strictEqual(exports["equal-i31-keys"](), 1);
  });

  it("throws the missing eqref key through the exported exception tag", () => {
    const tag = exports["dynamic-unbound"];
    const key = exports["key-a"]();
    let exception;
    try {
      exports.missing(null);
    } catch (caught) {
      exception = caught;
    }

    assert.instanceOf(exception, WebAssembly.Exception);
    assert.isTrue(exception.is(tag));
    assert.strictEqual(exception.getArg(tag, 0), key);
  });

  it("threads environments through virtual and proper tail calls", () => {
    const environment = exports["make-environment"]();
    const reader = exports["DynamicReader.new"]();
    assert.strictEqual(exports["dynamic-reader-has-key-a"](reader, null), 0);
    assert.strictEqual(exports["dynamic-reader-has-key-a"](reader, environment), 1);
    assert.strictEqual(exports["tail-loop"](null, 100_000), 1);
  });

  it("retains an explicitly threaded environment across JSPI suspension", async function () {
    if (typeof WebAssembly.Suspending !== "function") this.skip();
    const suspensionSource = `
      (type $key (struct (field i32)))
      (global $key (ref $key) (struct.new $key (i32.const 1)))
      (func $pause
        (param $value (ref eq))
        (result (ref eq))
        (local.get $value))
      (func $suspend
        (param $dynamic (ref null $dynamic.binding))
        (result i32)
        (local $inner (ref $dynamic.binding))
        (local.set $inner
          (dynamic:bind
            (local.get $dynamic)
            (global.get $key)
            (global.get $key)))
        (drop (call $pause (local.get $inner)))
        (dynamic:has (local.get $inner) (global.get $key)))
      (export-func suspend)
    `;
    const compiled = await compileBinary(suspensionSource, (sourceWat) => sourceWat
      .replace("(func $pause (param $value (ref eq)) (result (ref eq)) (local.get $value))", "")
      .replace(
        "(module",
        '(module\n(import "host" "pause" (func $pause (param (ref eq)) (result (ref eq))))',
      ));
    const pause = new WebAssembly.Suspending(async (value) => {
      await Promise.resolve();
      return value;
    });
    const { instance } = await WebAssembly.instantiate(compiled.binary, { host: { pause } });
    const suspend = WebAssembly.promising(instance.exports.suspend);
    assert.strictEqual(await suspend(null), 1);
  });

  it("reports malformed macros and reserved module replacement", async () => {
    for (const source of [
      "(func $bad (result (ref $dynamic.binding)) (dynamic:bind (ref.null $dynamic.binding) (ref.i31 (i32.const 1))))",
      "(func $bad (result i32) (dynamic:has (ref.null $dynamic.binding)))",
      "(func $bad (result (ref eq)) (dynamic:ref (ref.null $dynamic.binding)))",
    ]) {
      let error;
      try {
        await compileToWat({ sources: [{ name: "bad.idle", text: `(module ${source})` }] });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, "MACRO_EXPANDER_FAILED", source);
      assert.instanceOf(error?.cause, WebAssembly.RuntimeError, source);
    }

    let reserved;
    try {
      await compileToWat({
        sources: [{ name: "plain.idle", text: "(module (func $plain))" }],
        macroModules: { dynamic: new URL("fixtures/macros/identity.wat", import.meta.url) },
      });
    } catch (caught) {
      reserved = caught;
    }
    assert.strictEqual(reserved?.code, "RESERVED_MACRO_MODULE");

    let reservedExport;
    try {
      await compileToWat({
        sources: [{
          name: "reserved.idle",
          text: `(module
            (func $dynamic-unbound)
            (func $uses-dynamic (result i32)
              (dynamic:has (ref.null $dynamic.binding) (ref.i31 (i32.const 1))))
            (export-func dynamic-unbound))`,
        }],
      });
    } catch (caught) {
      reservedExport = caught;
    }
    assert.strictEqual(reservedExport?.code, "RESERVED_DYNAMIC_EXPORT");
  });
});
