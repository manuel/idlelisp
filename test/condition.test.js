import { readFile } from "node:fs/promises";

import { assert } from "chai";

import { compileToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";

const program = `(module
  (import "idle" "car"
    (func $condition-test.car (param (ref eq)) (result (ref eq))))
  (import "idle" "cons"
    (func $cons
      (param (ref eq))
      (param (ref eq))
      (result (ref eq))))

  (class child-error
    (extends simple-error)
    (field code i32))
  (class left-error (extends error))
  (class right-error (extends error))

  (type $condition-test.token (struct (field i32)))
  (global $condition-test.key (ref $condition-test.token)
    (struct.new $condition-test.token (i32.const 1)))
  (global $condition-test.value (ref $condition-test.token)
    (struct.new $condition-test.token (i32.const 2)))
  (global $condition-test.log (mut i32) (i32.const 0))
  (global $condition-test.cleanup (mut i32) (i32.const 0))
  (global $condition-test.application-visible (mut i32) (i32.const 0))
  (global $condition-test.restart-value (mut i32) (i32.const 0))

  (defun $condition-test.case-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:signal
      $environment
      ($child-error.new "child" (i32.const 7))))

  (defun $condition-test.return-context
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($value (ref eq))
     (ref eq))
    (ref.as_non_null $context))

  (defun $condition-test.case-result (i32)
    (i31.get_s
      (ref.cast (ref i31)
        (condition:handler-case
          (ref.null $dynamic.binding)
          ((simple-error $condition-test.return-context (ref.i31 (i32.const 42))))
          $condition-test.case-body
          (ref.null eq)))))

  (defun $condition-test.sibling-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:signal $environment ($right-error.new)))

  (defun $condition-test.sibling-result (i32)
    (i31.get_s
      (ref.cast (ref i31)
        (condition:handler-case
          (ref.null $dynamic.binding)
          ((left-error $condition-test.return-context (ref.i31 (i32.const 1)))
           (right-error $condition-test.return-context (ref.i31 (i32.const 2))))
          $condition-test.sibling-body
          (ref.null eq)))))

  (defun $condition-test.outer-handler
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($value (ref eq))
     (ref eq))
    (global.set $condition-test.log
      (i32.add (global.get $condition-test.log) (i32.const 1)))
    #nil)

  (defun $condition-test.inner-first
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($value (ref eq))
     (ref eq))
    (global.set $condition-test.log
      (i32.add (global.get $condition-test.log) (i32.const 10)))
    #nil)

  (defun $condition-test.inner-second
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($value (ref eq))
     (ref eq))
    (global.set $condition-test.log
      (i32.add (global.get $condition-test.log) (i32.const 100)))
    #nil)

  (defun $condition-test.signal-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:signal $environment ($simple-error.new "decline")))

  (defun $condition-test.install-inner
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:handler-bind
      $environment
      ((error $condition-test.inner-first (ref.null eq))
       (simple-error $condition-test.inner-second (ref.null eq)))
      $condition-test.signal-body
      (ref.null eq)))

  (defun $condition-test.bind-order (i32)
    (global.set $condition-test.log (i32.const 0))
    (drop
      (condition:handler-bind
        (ref.null $dynamic.binding)
        ((condition $condition-test.outer-handler (ref.null eq)))
        $condition-test.install-inner
        (ref.null eq)))
    (global.get $condition-test.log))

  (defun $condition-test.probe-restart
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($arguments (ref eq))
     (ref eq))
    (ref.i31 (i32.const 7)))

  (defun $condition-test.firewall-handler
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($value (ref eq))
     (ref eq))
    (global.set $condition-test.application-visible
      (dynamic:has $environment (global.get $condition-test.key)))
    (global.set $condition-test.restart-value
      (i31.get_s
        (ref.cast (ref i31)
          (condition:invoke-restart $environment 'probe #nil))))
    #nil)

  (defun $condition-test.firewall-signal
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (let $application (ref $dynamic.binding)
      (dynamic:bind
        $environment
        (global.get $condition-test.key)
        (global.get $condition-test.value)))
    (condition:signal $application ($simple-error.new "firewall")))

  (defun $condition-test.install-restart
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:restart-bind
      $environment
      ((probe $condition-test.probe-restart (ref.null eq)))
      $condition-test.firewall-signal
      (ref.null eq)))

  (defun $condition-test.firewall (i32)
    (global.set $condition-test.application-visible (i32.const 0))
    (global.set $condition-test.restart-value (i32.const 0))
    (drop
      (condition:handler-bind
        (ref.null $dynamic.binding)
        ((simple-error $condition-test.firewall-handler (ref.null eq)))
        $condition-test.install-restart
        (ref.null eq)))
    (i32.add
      (i32.mul (global.get $condition-test.application-visible) (i32.const 10))
      (global.get $condition-test.restart-value)))

  (defun $condition-test.cleanup-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (control:unwind-protect
      (result (ref eq))
      (condition:signal $environment ($simple-error.new "cleanup"))
      (global.set $condition-test.cleanup (i32.const 1))))

  (defun $condition-test.cleanup-handler
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($value (ref eq))
     (ref eq))
    (ref.i31 (global.get $condition-test.cleanup)))

  (defun $condition-test.case-cleanup (i32)
    (global.set $condition-test.cleanup (i32.const 0))
    (i31.get_s
      (ref.cast (ref i31)
        (condition:handler-case
          (ref.null $dynamic.binding)
          ((simple-error $condition-test.cleanup-handler (ref.null eq)))
          $condition-test.cleanup-body
          (ref.null eq)))))

  (defun $condition-test.restart-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:invoke-restart $environment 'retry #nil))

  (defun $condition-test.restart-handler
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($arguments (ref eq))
     (ref eq))
    (ref.as_non_null $context))

  (defun $condition-test.restart-case-result (i32)
    (i31.get_s
      (ref.cast (ref i31)
        (condition:restart-case
          (ref.null $dynamic.binding)
          ((retry $condition-test.restart-handler (ref.i31 (i32.const 9))))
          $condition-test.restart-body
          (ref.null eq)))))

  (defun $condition-test.missing-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:invoke-restart $environment 'absent #nil))

  (defun $condition-test.missing-handler
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($value (ref eq))
     (ref eq))
    (ref.i31 (i32.const 77)))

  (defun $condition-test.missing-restart (i32)
    (i31.get_s
      (ref.cast (ref i31)
        (condition:handler-case
          (ref.null $dynamic.binding)
          ((restart-error $condition-test.missing-handler (ref.null eq)))
          $condition-test.missing-body
          (ref.null eq)))))

  (defun $condition-test.bad-name-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:invoke-restart $environment (ref.i31 (i32.const 3)) #nil))

  (defun $condition-test.bad-arguments-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:invoke-restart $environment 'absent (ref.i31 (i32.const 3))))

  (defun $condition-test.bad-name (i32)
    (i31.get_s
      (ref.cast (ref i31)
        (condition:handler-case
          (ref.null $dynamic.binding)
          ((simple-error $condition-test.return-context (ref.i31 (i32.const 66))))
          $condition-test.bad-name-body
          (ref.null eq)))))

  (defun $condition-test.bad-arguments (i32)
    (i31.get_s
      (ref.cast (ref i31)
        (condition:handler-case
          (ref.null $dynamic.binding)
          ((simple-error $condition-test.return-context (ref.i31 (i32.const 67))))
          $condition-test.bad-arguments-body
          (ref.null eq)))))

  (defun $condition-test.deep-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (let $remaining i32
      (i31.get_s (ref.cast (ref i31) (ref.as_non_null $context))))
    (if (result (ref eq))
      (i32.eqz $remaining)
      (then
        (condition:signal $environment ($simple-error.new "deep")))
      (else
        (condition:handler-bind
          $environment
          ()
          $condition-test.deep-body
          (ref.i31 (i32.sub $remaining (i32.const 1)))))))

  (defun $condition-test.deep-traversal (i32)
    (i31.get_s
      (ref.cast (ref i31)
        (condition:handler-case
          (ref.null $dynamic.binding)
          ((simple-error $condition-test.return-context (ref.i31 (i32.const 88))))
          $condition-test.deep-body
          (ref.i31 (i32.const 500))))))

  (defun $condition-test.compute-body
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:compute-restarts $environment))

  (defun $condition-test.compute-inner
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:restart-bind
      $environment
      ((retry $condition-test.use-value (ref.null eq))
       (dance $condition-test.use-value (ref.null eq)))
      $condition-test.compute-body
      (ref.null eq)))

  (defun $condition-test.compute-restarts ((ref eq))
    (condition:restart-bind
      (ref.null $dynamic.binding)
      ((retry $condition-test.use-value (ref.null eq)))
      $condition-test.compute-inner
      (ref.null eq)))

  (defun $condition-test.fetch-dragon
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:error
      $environment
      ($simple-error.new "The dragon escaped")))

  (defun $condition-test.use-value
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($arguments (ref eq))
     (ref eq))
    ($condition-test.car $arguments))

  (defun $condition-test.fetch-with-rescue
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     (ref eq))
    (condition:restart-case
      $environment
      ((use-value $condition-test.use-value (ref.null eq)))
      $condition-test.fetch-dragon
      (ref.null eq)))

  (defun $condition-test.handle-missing-dragon
    (($environment (ref null $dynamic.binding))
     ($context (ref null eq))
     ($problem (ref eq))
     (ref eq))
    (condition:invoke-restart
      $environment
      'use-value
      (list:list "emergency inflatable dragon")))

  (defun $condition-test.dragon ((ref eq))
    (condition:handler-bind
      (ref.null $dynamic.binding)
      ((simple-error
         $condition-test.handle-missing-dragon
         (ref.null eq)))
      $condition-test.fetch-with-rescue
      (ref.null eq)))

  (defun $condition-test.make-error ((ref $condition))
    ($simple-error.new "unhandled"))

  (defun $condition-test.raise
    (($value (ref $condition)) (ref eq))
    (condition:error (ref.null $dynamic.binding) $value))

  (export "condition-test.case-result" (func $condition-test.case-result))
  (export "condition-test.sibling-result" (func $condition-test.sibling-result))
  (export "condition-test.bind-order" (func $condition-test.bind-order))
  (export "condition-test.firewall" (func $condition-test.firewall))
  (export "condition-test.case-cleanup" (func $condition-test.case-cleanup))
  (export "condition-test.restart-case-result" (func $condition-test.restart-case-result))
  (export "condition-test.missing-restart" (func $condition-test.missing-restart))
  (export "condition-test.bad-name" (func $condition-test.bad-name))
  (export "condition-test.bad-arguments" (func $condition-test.bad-arguments))
  (export "condition-test.deep-traversal" (func $condition-test.deep-traversal))
  (export "condition-test.compute-restarts" (func $condition-test.compute-restarts))
  (export "condition-test.dragon" (func $condition-test.dragon))
  (export "condition-test.make-error" (func $condition-test.make-error))
  (export "condition-test.raise" (func $condition-test.raise)))`;

async function compileBinary(source) {
  const wat = await compileToWat({ sources: [{ name: "condition-test.idle", text: source }] });
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

describe("conditions and named restarts", () => {
  let objects;
  let exports;
  let wat;

  before(async () => {
    ({ instance: { exports: objects } } = await WebAssembly.instantiate(
      await readFile(new URL("../build/objects.wasm", import.meta.url)),
    ));
    const compiled = await compileBinary(program);
    wat = compiled.wat;
    const idle = {
      nil: objects.abi_nil,
      is_nil: objects.abi_is_nil,
      cons: objects.abi_cons,
      is_cons: objects.abi_is_cons,
      car: objects.abi_car,
      cdr: objects.abi_cdr,
      list_reverse_prepend: objects.abi_list_reverse_prepend,
      is_symbol: objects.abi_is_symbol,
      symbol_has_module: objects.abi_symbol_has_module,
      intern: objects.abi_intern,
    };
    ({ instance: { exports } } = await WebAssembly.instantiate(compiled.binary, { idle }));
  });

  it("matches subclasses and unwinds handler-case to the selected handler", () => {
    assert.strictEqual(exports["condition-test.case-result"](), 42);
  });

  it("distinguishes structurally equivalent sibling condition classes", () => {
    assert.strictEqual(exports["condition-test.sibling-result"](), 2);
  });

  it("selects one handler per frame, then declines toward parent frames", () => {
    assert.strictEqual(exports["condition-test.bind-order"](), 11);
  });

  it("preserves signal-point restart and application bindings behind the firewall", () => {
    assert.strictEqual(exports["condition-test.firewall"](), 17);
  });

  it("runs unwind-protect cleanup before a case handler", () => {
    assert.strictEqual(exports["condition-test.case-cleanup"](), 1);
  });

  it("invokes named case restarts and reports missing names as conditions", () => {
    assert.strictEqual(exports["condition-test.restart-case-result"](), 9);
    assert.strictEqual(exports["condition-test.missing-restart"](), 77);
    assert.strictEqual(exports["condition-test.bad-name"](), 66);
    assert.strictEqual(exports["condition-test.bad-arguments"](), 67);
  });

  it("searches a deep immutable frame chain iteratively", () => {
    assert.strictEqual(exports["condition-test.deep-traversal"](), 88);
  });

  it("computes restart names in lookup order and retains shadowed duplicates", () => {
    const names = [];
    let cursor = exports["condition-test.compute-restarts"]();
    while (objects.abi_is_nil(cursor) === 0) {
      const symbol = objects.abi_car(cursor);
      const name = objects.abi_symbol_name(symbol);
      const bytes = Array.from(
        { length: objects.abi_string_length(name) },
        (_, index) => objects.abi_string_byte(name, index),
      );
      names.push(new TextDecoder().decode(Uint8Array.from(bytes)));
      cursor = objects.abi_cdr(cursor);
    }
    assert.deepEqual(names, ["retry", "dance", "retry"]);
  });

  it("recovers an escaped dragon by invoking a use-value restart", () => {
    const value = exports["condition-test.dragon"]();
    assert.strictEqual(objects.abi_is_string(value), 1);
    const bytes = Array.from(
      { length: objects.abi_string_length(value) },
      (_, index) => objects.abi_string_byte(value, index),
    );
    assert.strictEqual(
      new TextDecoder().decode(Uint8Array.from(bytes)),
      "emergency inflatable dragon",
    );
  });

  it("exports the exact unhandled condition payload", () => {
    const tag = exports["condition-unhandled"];
    const value = exports["condition-test.make-error"]();
    let exception;
    try {
      exports["condition-test.raise"](value);
    } catch (caught) {
      exception = caught;
    }
    assert.instanceOf(exception, WebAssembly.Exception);
    assert.isTrue(exception.is(tag));
    assert.strictEqual(exception.getArg(tag, 0), value);
  });

  it("keeps the runtime opt-in and private", async () => {
    assert.include(wat, "$condition.handler.frame");
    assert.include(wat, "$condition.restart.frame");
    assert.notInclude(wat, "restart-lookup");
    assert.notInclude(wat, "restart-enumerate");

    const plain = await compileToWat({
      sources: [{ name: "plain.idle", text: "(module (func $plain))" }],
    });
    assert.notInclude(plain, "$condition");
    assert.notInclude(plain, "$dynamic.binding");
  });

  it("rejects unknown classes, non-condition classes, and invalid callbacks", async () => {
    const common = `
      (defun $bad-body
        (($environment (ref null $dynamic.binding))
         ($context (ref null eq))
         (ref eq))
        #nil)
      (defun $bad-handler
        (($environment (ref null $dynamic.binding))
         ($context (ref null eq))
         ($value (ref eq))
         (ref eq))
        #nil)`;
    const cases = [
      {
        code: "UNKNOWN_CLASS",
        extra: "",
        spec: "(missing $bad-handler (ref.null eq))",
      },
      {
        code: "NOT_CONDITION_CLASS",
        extra: "(class ordinary)",
        spec: "(ordinary $bad-handler (ref.null eq))",
      },
      {
        code: "INVALID_CONDITION_CALLBACK",
        extra: "",
        spec: "(condition bad-handler (ref.null eq))",
      },
    ];

    for (const item of cases) {
      let error;
      try {
        await compileToWat({
          sources: [{
            name: "bad-condition.idle",
            text: `(module
              ${item.extra}
              ${common}
              (defun $bad ((ref eq))
                (condition:handler-bind
                  (ref.null $dynamic.binding)
                  (${item.spec})
                  $bad-body
                  (ref.null eq))))`,
          }],
        });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, item.code);
    }
  });
});
