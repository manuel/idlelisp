import { assert } from "chai";

import { compileToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";

const program = `
  (type $token (struct (field i32)))
  (global $token (ref $token) (struct.new $token (i32.const 1)))
  (global $normal-cleanups (mut i32) (i32.const 0))
  (global $zero-cleanups (mut i32) (i32.const 0))
  (global $reference-cleanups (mut i32) (i32.const 0))
  (global $multiple-cleanups (mut i32) (i32.const 0))
  (global $exception-cleanups (mut i32) (i32.const 0))
  (global $return-cleanups (mut i32) (i32.const 0))
  (global $trap-cleanups (mut i32) (i32.const 0))
  (tag $protected-error)
  (tag $cleanup-error)

  (func $normal (result i32)
    (control:unwind-protect
      (result i32)
      (i32.const 41)
      (global.set $normal-cleanups
        (i32.add (global.get $normal-cleanups) (i32.const 1)))))

  (func $zero
    (control:unwind-protect
      (result)
      (nop)
      (global.set $zero-cleanups
        (i32.add (global.get $zero-cleanups) (i32.const 1)))))

  (func $reference (result (ref eq))
    (control:unwind-protect
      (result (ref eq))
      (global.get $token)
      (global.set $reference-cleanups
        (i32.add (global.get $reference-cleanups) (i32.const 1)))))

  (func $token-value (result (ref eq))
    (global.get $token))

  (func $multiple (result i32 i64)
    (control:unwind-protect
      (result i32 i64)
      (block (result i32 i64)
        (i32.const 7)
        (i64.const 9))
      (global.set $multiple-cleanups
        (i32.add (global.get $multiple-cleanups) (i32.const 1)))))

  (func $exceptional (result i32)
    (control:unwind-protect
      (result i32)
      (throw $protected-error)
      (global.set $exception-cleanups
        (i32.add (global.get $exception-cleanups) (i32.const 1)))))

  (func $cleanup-replaces-original (result i32)
    (try (result i32)
      (do
        (control:unwind-protect
          (result i32)
          (throw $protected-error)
          (throw $cleanup-error)))
      (catch $protected-error (i32.const 1))
      (catch $cleanup-error (i32.const 2))))

  (func $unsafe-return (result i32)
    (control:unwind-protect
      (result i32)
      (return (i32.const 17))
      (global.set $return-cleanups (i32.const 1))))

  (func $unsafe-trap
    (control:unwind-protect
      (result)
      (unreachable)
      (global.set $trap-cleanups (i32.const 1))))

  (func $normal-cleanup-count (result i32) (global.get $normal-cleanups))
  (func $zero-cleanup-count (result i32) (global.get $zero-cleanups))
  (func $reference-cleanup-count (result i32) (global.get $reference-cleanups))
  (func $multiple-cleanup-count (result i32) (global.get $multiple-cleanups))
  (func $exception-cleanup-count (result i32) (global.get $exception-cleanups))
  (func $return-cleanup-count (result i32) (global.get $return-cleanups))
  (func $trap-cleanup-count (result i32) (global.get $trap-cleanups))

  (export-func normal)
  (export-func zero)
  (export-func reference)
  (export-func token-value)
  (export-func multiple)
  (export-func exceptional)
  (export-func cleanup-replaces-original)
  (export-func unsafe-return)
  (export-func unsafe-trap)
  (export-func normal-cleanup-count)
  (export-func zero-cleanup-count)
  (export-func reference-cleanup-count)
  (export-func multiple-cleanup-count)
  (export-func exception-cleanup-count)
  (export-func return-cleanup-count)
  (export-func trap-cleanup-count)
`;

async function compileBinary(source) {
  const wat = await compileToWat({
    sources: [{ name: "control.idle", text: `(module\n${source}\n)` }],
  });
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

describe("unsafe unwind protection", () => {
  let wat;
  let exports;

  before(async () => {
    const compiled = await compileBinary(program);
    wat = compiled.wat;
    ({ instance: { exports } } = await WebAssembly.instantiate(compiled.binary));
  });

  it("expands to Wasm exception handling and preserves normal result shapes", () => {
    assert.include(wat, "(try (result i32)");
    assert.include(wat, "(catch_all");

    assert.strictEqual(exports.normal(), 41);
    assert.strictEqual(exports["normal-cleanup-count"](), 1);

    assert.strictEqual(exports.zero(), undefined);
    assert.strictEqual(exports["zero-cleanup-count"](), 1);

    assert.strictEqual(exports.reference(), exports["token-value"]());
    assert.strictEqual(exports["reference-cleanup-count"](), 1);

    assert.deepEqual(exports.multiple(), [7, 9n]);
    assert.strictEqual(exports["multiple-cleanup-count"](), 1);
  });

  it("runs cleanup before rethrowing a protected Wasm exception", () => {
    assert.throws(() => exports.exceptional(), WebAssembly.Exception);
    assert.strictEqual(exports["exception-cleanup-count"](), 1);
  });

  it("lets a cleanup exception replace the protected exception", () => {
    assert.strictEqual(exports["cleanup-replaces-original"](), 2);
  });

  it("leaves raw returns and traps explicitly unsafe", () => {
    assert.strictEqual(exports["unsafe-return"](), 17);
    assert.strictEqual(exports["return-cleanup-count"](), 0);

    assert.throws(() => exports["unsafe-trap"](), WebAssembly.RuntimeError);
    assert.strictEqual(exports["trap-cleanup-count"](), 0);
  });

  it("traps malformed forms and reserves the control module name", async () => {
    for (const source of [
      "(func $bad (control:unwind-protect (result)))",
      "(func $bad (control:unwind-protect i32 (nop)))",
      "(func $bad (control:unwind-protect (wrong i32) (i32.const 1)))",
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
        macroModules: { control: new URL("fixtures/macros/identity.wat", import.meta.url) },
      });
    } catch (caught) {
      reserved = caught;
    }
    assert.strictEqual(reserved?.code, "RESERVED_MACRO_MODULE");
  });
});
