import { assert } from "chai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { compileFilesToWat, compileToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";

async function instantiate(wat, imports = {}) {
  const { default: binaryen } = await import("binaryen");
  const module = binaryen.parseText(wat);
  try {
    module.setFeatures(idleWasmFeatures(binaryen));
    assert.isOk(module.validate());
    return (await WebAssembly.instantiate(module.emitBinary(), imports)).instance.exports;
  } finally {
    module.dispose();
  }
}

function source(name, text) {
  return { name, text: `(module\n${text}\n)` };
}

function runCli(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/idlec.mjs", import.meta.url)), ...arguments_],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("Idle class compiler", () => {
  it("passes ordinary explicit WAT modules through without generated scaffolding", async () => {
    const wat = await compileToWat({ sources: [{
      name: "plain.idle",
      text: `(module
        (func $answer (result i32) (i32.const 42))
        (export "answer" (func $answer)))`,
    }] });

    assert.notInclude(wat, "$dynamic.binding");
    assert.notInclude(wat, "(type $tag");
    const exports = await instantiate(wat);
    assert.strictEqual(exports.answer(), 42);
  });

  it("lowers expression strings to canonical UTF-8 GC arrays", async () => {
    const wat = await compileToWat({ sources: [{
      name: "strings.idle",
      text: `(module
        (func $same (result i32) (ref.eq "hé" "hé"))
        (func $different (result i32) (ref.eq "hé" "other"))
        (export "same" (func $same))
        (export "different" (func $different)))`,
    }] });

    const exports = await instantiate(wat);
    assert.strictEqual(exports.same(), 1);
    assert.strictEqual(exports.different(), 0);
    assert.strictEqual((wat.match(/\(global \$idle\.string\.0 /g) ?? []).length, 1);
    assert.include(wat, "(i32.const 195) (i32.const 169)");
    assert.include(wat, '(export "same"');
  });

  it("lowers #nil and () expressions to canonical nil", async () => {
    const wat = await compileToWat({ sources: [{
      name: "nil.idle",
      text: `(module
        (func $sharp (result (ref eq)) #nil)
        (func $empty (result (ref eq)) ())
        (func $quoted-sharp (result (ref eq)) '#nil)
        (func $quoted-empty (result (ref eq)) '())
        (func $same (result i32)
          (i32.and
            (ref.eq #nil ())
            (i32.and
              (ref.eq #nil '#nil)
              (ref.eq #nil '()))))
        (export "sharp" (func $sharp))
        (export "empty" (func $empty))
        (export "quoted-sharp" (func $quoted-sharp))
        (export "quoted-empty" (func $quoted-empty))
        (export "same" (func $same)))`,
    }] });

    const { instance: runtime } = await WebAssembly.instantiate(
      await readFile(new URL("../build/objects.wasm", import.meta.url)),
    );
    const exports = await instantiate(wat, { idle: { nil: runtime.exports.abi_nil } });
    assert.strictEqual(exports.same(), 1);
    assert.strictEqual(runtime.exports.abi_is_nil(exports.sharp()), 1);
    assert.strictEqual(exports.sharp(), exports.empty());
    assert.strictEqual(exports.sharp(), exports["quoted-sharp"]());
    assert.strictEqual(exports.sharp(), exports["quoted-empty"]());
    assert.strictEqual((wat.match(/\(import "idle" "nil"/g) ?? []).length, 1);
  });

  it("lowers quoted symbols to one initialized non-null global", async () => {
    const wat = await compileToWat({ sources: [{
      name: "symbols.idle",
      text: `(module
        (global $started (mut i32) (i32.const 0))
        (func $initialize
          (global.set $started (ref.eq 'foo 'foo)))
        (user-start $initialize)
        (func $symbol (result (ref eq)) 'foo)
        (func $started (result i32) (global.get $started))
        (export "symbol" (func $symbol))
        (export "started" (func $started)))`,
    }] });

    const { instance: runtime } = await WebAssembly.instantiate(
      await readFile(new URL("../build/objects.wasm", import.meta.url)),
    );
    const exports = await instantiate(wat, { idle: { intern: runtime.exports.abi_intern } });
    assert.strictEqual(exports.started(), 1);
    assert.strictEqual(runtime.exports.abi_is_symbol(exports.symbol()), 1);
    assert.strictEqual((wat.match(/\(global \$idle\.symbol\.0 /g) ?? []).length, 1);
    assert.notInclude(wat, "$idle.symbol.1");
    assert.include(wat, `(func $idle.start
  (call $idle.initialize-symbols)
  (call $initialize))`);
  });

  it("lowers user-start directly when symbol initialization is unnecessary", async () => {
    const wat = await compileToWat({ sources: [{
      name: "start.idle",
      text: `(module
        (global $value (mut i32) (i32.const 0))
        (func $initialize (global.set $value (i32.const 42)))
        (user-start $initialize)
        (func $value (result i32) (global.get $value))
        (export "value" (func $value)))`,
    }] });

    const exports = await instantiate(wat);
    assert.strictEqual(exports.value(), 42);
    assert.include(wat, "(start $initialize)");
    assert.notInclude(wat, "$idle.initialize-symbols");
  });

  it("rejects unsupported quotes and conflicting starts", async () => {
    const cases = [
      ["(module (func $f (result (ref eq)) '(foo)))", "UNSUPPORTED_QUOTE_LITERAL"],
      ["(module (func $f (result (ref eq)) 'tools:foo))", "QUALIFIED_SYMBOL_LITERAL_UNSUPPORTED"],
      ["(module (user-start initialize))", "INVALID_USER_START"],
      ["(module (func $a) (func $b) (user-start $a) (user-start $b))", "DUPLICATE_USER_START"],
      ["(module (func $a) (start $a) (user-start $a))", "DUPLICATE_START"],
      ["(module (func $a) (start $a) (func $f (result (ref eq)) 'foo))", "RAW_START_WITH_SYMBOLS"],
      ["(module (func $idle.intern) (func $f (result (ref eq)) 'foo))", "RESERVED_SYMBOL_LITERAL_IDENTIFIER"],
    ];
    for (const [text, code] of cases) {
      let error;
      try {
        await compileToWat({ sources: [{ name: "invalid-symbol.idle", text }] });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, code, text);
    }
  });

  it("lowers named calls and bare local operands through WAT operand policies", async () => {
    const wat = await compileToWat({ sources: [{
      name: "shorthand.idle",
      text: `(module
        (type $Box (struct (field $value i32)))
        (func $read (param $box (ref $Box)) (result i32)
          (struct.get $Box $value $box))
        (func $twice (param $value i32) (result i32)
          (local $saved i32)
          (local.set $saved $value)
          (block $done
            (br_if $done (i32.eqz $saved))
            (local.set $saved (i32.add $saved $value)))
          $saved)
        (func $main (result i32)
          ($twice ($read (struct.new $Box (i32.const 21)))))
        (export "main" (func $main)))`,
    }] });

    const exports = await instantiate(wat);
    assert.strictEqual(exports.main(), 42);
    assert.include(wat, "(call $twice (call $read");
    assert.include(wat, "(struct.get $Box $value (local.get $box))");
    assert.notInclude(wat, "(local.get $Box)");
    assert.notInclude(wat, "(local.get $done)");
  });

  it("lowers defun signatures to WAT parameters and results", async () => {
    const wat = await compileToWat({ sources: [{
      name: "defun.idle",
      text: `(module
        (type $dynamic.binding (struct
          (field $parent (ref null $dynamic.binding))
          (field $key (ref eq))))
        (defun $dynamic.find
          (($environment (ref null $dynamic.binding))
           ($key (ref eq))
           (ref null $dynamic.binding))
          (drop $key)
          $environment)
        (defun $answer (i32)
          (i32.const 42))
        (export "answer" (func $answer)))`,
    }] });

    const exports = await instantiate(wat);
    assert.strictEqual(exports.answer(), 42);
    assert.include(wat, "(func $dynamic.find (param $environment (ref null $dynamic.binding)) (param $key (ref eq)) (result (ref null $dynamic.binding))");
    assert.include(wat, "(func $answer (result i32)");
  });

  it("checks typed-defun calls with the same signature shape as defun", async () => {
    const wat = await compileToWat({ sources: [source("typed.idle", `
      (typed-defun $answer (i32)
        (i32.add ($identity 20) ($identity 21)))
      (typed-defun $identity (($value i32) i32)
        $value)
      (export-func answer)
    `)] });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.answer(), 41);
    assert.include(wat, "(func $answer (result i32)");
    assert.include(wat, "(call $identity (i32.const 20))");
  });

  it("accepts compact defclass roots, superclass lists, and direct fields", async () => {
    const wat = await compileToWat({ sources: [source("defclass.idle", `
      (defclass Root)
      (defclass ExplicitRoot ())
      (defclass Base ()
        (value i32)
        (count (mut i32)))
      (defclass Child (Base)
        (offset i32))
      (export-new Root)
      (export-new ExplicitRoot)
      (export-new Base)
      (export-new Child)
    `)] });
    const exports = await instantiate(wat);

    assert.doesNotThrow(() => exports["Root.new"]());
    assert.doesNotThrow(() => exports["ExplicitRoot.new"]());
    assert.doesNotThrow(() => exports["Base.new"](1, 2));
    assert.doesNotThrow(() => exports["Child.new"](1, 2, 3));
    assert.include(
      wat,
      "(func $Child.new (param $value i32) (param $count i32) (param $offset i32)",
    );
    assert.include(wat, "(field $count (mut i32))");
  });

  it("checks typed constructors, nominal upcasts, and inherited generic methods", async () => {
    const wat = await compileToWat({ sources: [source("typed-objects.idle", `
      (defclass A)
      (defclass B (A))
      (defgeneric $value ((object A) i32))
      (defmethod $value ((object A) i32) (i32.const 7))
      (typed-defun $make (A)
        ($B.new))
      (typed-defun $read (i32)
        ($value ($make)))
      (export-func read)
    `)] });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.read(), 7);
    assert.include(wat, "(call $B.new)");
    assert.include(wat, "(call $value (call $make))");
  });

  it("checks ordinary generic dispatch from typed local declarations", async () => {
    const wat = await compileFilesToWat({
      inputPaths: [new URL("../benchmark/oop-list.idle", import.meta.url)],
    });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.count(exports.build(0)), 0);
    assert.strictEqual(exports.count(exports.build(1)), 1);
    assert.strictEqual(exports.count(exports.build(37)), 37);
    assert.include(wat, "(call $is-empty (local.get $cursor))");
    assert.include(wat, "(call $tail (local.get $cursor))");
    assert.include(wat, "(local $cursor (ref $List))");
  });

  it("reports static errors in typed-defun before WAT validation", async () => {
    const cases = [
      ["(typed-defun $bad (() i32) 0)", "INVALID_TYPED_PARAMETER"],
      ["(typed-defun $bad (($value Missing) i32) 0)", "UNKNOWN_CHECKED_TYPE"],
      ["(typed-defun $bad (($value i32) i32) (set $value 1) $value)", "PARAMETER_ASSIGNMENT"],
      ["(typed-defun $bad (i32) (let $value i32 0) (let $value i32 1) $value)", "DUPLICATE_LOCAL"],
      ["(typed-defun $bad (i32) $missing)", "UNKNOWN_TYPED_LOCAL"],
      ["(typed-defun $bad (($value i32) i32) (.tail $value))", "METHOD_SEND_SYNTAX_REMOVED"],
      ["(defclass A) (typed-defun $bad (($value A) i32) (.missing $value))", "METHOD_SEND_SYNTAX_REMOVED"],
      ["(defclass A) (defgeneric $f ((a A) (value i32) i32)) (defmethod $f ((a A) (value i32) i32) $value) (typed-defun $bad (($a A) i32) ($f $a))", "TYPED_CALL_ARITY"],
      ["(typed-defun $bad (($value i32) i32) (i32.mul $value 2))", "UNSUPPORTED_TYPED_EXPRESSION"],
      ["(typed-defun $bad (($value i32) i32) (while $value (let $x i32 0)) 0)", "NESTED_TYPED_LOCAL"],
      ["(defclass A) (defclass B (A)) (typed-defun $bad (($value A) B) $value)", "TYPE_MISMATCH"],
      ["(defclass A) (defclass B (A)) (defgeneric $f ((a A) (value i32) i32)) (defmethod $f ((b B) i32) (i32.const 0))", "METHOD_SIGNATURE_MISMATCH"],
    ];

    for (const [text, code] of cases) {
      let error;
      try {
        await compileToWat({ sources: [source("typed-error.idle", text)] });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, code, text);
      assert.strictEqual(error?.sourceName, "typed-error.idle", text);
    }
  });

  it("lowers elif clauses to nested WAT if expressions", async () => {
    const wat = await compileToWat({ sources: [{
      name: "elif.idle",
      text: `(module
        (defun $classify (($value i32) i32)
          (if (result i32)
            (i32.eq $value (i32.const 0))
            (then (i32.const 10))
            (elif (i32.eq $value (i32.const 1))
              (i32.const 20))
            (elif (i32.eq $value (i32.const 2))
              (i32.const 30))
            (else (i32.const 40))))
        (export "classify" (func $classify)))`,
    }] });

    const exports = await instantiate(wat);
    assert.deepEqual([0, 1, 2, 3].map(exports.classify), [10, 20, 30, 40]);
    assert.notInclude(wat, "elif");
    assert.include(wat, "(else (if (result i32)");
  });

  it("hoists built-in let locals and initializes them in source order", async () => {
    const wat = await compileToWat({ sources: [{
      name: "let.idle",
      text: `(module
        (func $calculate (param $input i32) (result i32)
          (let $double i32 (i32.add $input $input))
          (local $unused i32)
          (let $answer i32 (i32.add $double (i32.const 2)))
          $answer)
        (export "calculate" (func $calculate)))`,
    }] });

    const exports = await instantiate(wat);
    assert.strictEqual(exports.calculate(20), 42);
    const explicitDeclaration = wat.indexOf("(local $unused i32)");
    const firstDeclaration = wat.indexOf("(local $double i32)");
    const secondDeclaration = wat.indexOf("(local $answer i32)");
    const firstInitialization = wat.indexOf("(local.set $double");
    const secondInitialization = wat.indexOf("(local.set $answer");
    assert.isAtLeast(explicitDeclaration, 0);
    assert.isAbove(firstDeclaration, explicitDeclaration);
    assert.isAbove(secondDeclaration, firstDeclaration);
    assert.isAbove(firstInitialization, secondDeclaration);
    assert.isAbove(secondInitialization, firstInitialization);
  });

  it("rejects malformed or nested lets", async () => {
    const cases = [
      ["(module (func $bad (let value i32 (i32.const 1))))", "INVALID_LET"],
      ["(module (func $bad (block (let $value i32 (i32.const 1)))))", "LET_OUTSIDE_FUNCTION"],
    ];
    for (const [text, code] of cases) {
      let error;
      try {
        await compileToWat({ sources: [{ name: "bad-let.idle", text }] });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, code, text);
    }
  });

  it("lowers built-in set to local.set", async () => {
    const wat = await compileToWat({ sources: [{
      name: "set.idle",
      text: `(module
        (func $increment (param $value i32) (result i32)
          (set $value (i32.add $value (i32.const 1)))
          $value)
        (export "increment" (func $increment)))`,
    }] });

    const exports = await instantiate(wat);
    assert.strictEqual(exports.increment(41), 42);
    assert.include(wat, "(local.set $value (i32.add");
  });

  it("rejects malformed set forms", async () => {
    let error;
    try {
      await compileToWat({ sources: [{
        name: "bad-set.idle",
        text: "(module (func $bad (set value (i32.const 1))))",
      }] });
    } catch (caught) {
      error = caught;
    }
    assert.strictEqual(error?.code, "INVALID_SET");
  });

  it("keeps strings in WAT data fields structural", async () => {
    const wat = await compileToWat({ sources: [{
      name: "data.idle",
      text: `(module
        (memory 1)
        (data (i32.const 0) "raw bytes"))`,
    }] });

    assert.include(wat, '(data (i32.const 0) "raw bytes")');
    assert.notInclude(wat, "$idle.string-data");
  });

  it("flattens explicit module fields across files before validation", async () => {
    const wat = await compileToWat({ sources: [
      { name: "definition.idle", text: "(module (func $answer (result i32) (i32.const 42)))" },
      { name: "export.idle", text: '(module (export "answer" (func $answer)))' },
    ] });
    const exports = await instantiate(wat);
    assert.strictEqual(exports.answer(), 42);
  });

  it("requires one unnamed explicit module per input", async () => {
    for (const [text, code] of [
      ["(func $plain)", "EXPECTED_MODULE"],
      ["(module) (module)", "EXPECTED_MODULE"],
      ["(module $named)", "NAMED_MODULE_UNSUPPORTED"],
    ]) {
      let error;
      try {
        await compileToWat({ sources: [{ name: "shape.idle", text }] });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, code, text);
      assert.strictEqual(error?.sourceName, "shape.idle", text);
    }
  });

  it("compiles cross-file inheritance, generic calls, next methods, and mutation", async () => {
    const base = new URL("../example/classes/", import.meta.url);
    const wat = await compileFilesToWat({
      inputPaths: [
        new URL("offset-counter.idle", base),
        new URL("counter.idle", base),
        new URL("main.idle", base),
      ],
    });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.main(), 22);
    const counter = exports["Counter.new"](17);
    assert.strictEqual(exports.read(counter), 17);
    assert.strictEqual(exports.write(counter, 31), 0);
    assert.strictEqual(exports.read(counter), 31);
    assert.match(wat, /\(func \$read /);
    assert.match(wat, /\$generic\.read\.OffsetCounter\.impl/);
  });

  it("supports virtual tail calls without growing the native stack", async () => {
    const wat = await compileToWat({ sources: [source("tail.idle", `
      (defclass Countdown)
      (defgeneric $run ((countdown Countdown) (remaining i32) i32))
      (defmethod $run ((countdown Countdown) (remaining i32) i32)
        (if (result i32)
          (i32.eqz (local.get $remaining))
          (then (i32.const 7))
          (else
            (return_call $run
              (local.get $countdown)
              (i32.sub (local.get $remaining) (i32.const 1))))))
      (export-new Countdown)
      (export-func run)
    `)] });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.run(exports["Countdown.new"](), 100_000), 7);
  });

  it("passes explicit replacement arguments to the nearest next method", async () => {
    const wat = await compileToWat({ sources: [source("next.idle", `
      (defclass A)
      (defclass B (A))
      (defclass C (B))
      (defmethod $value ((object C) (value i32) i32)
        (call-next-method $object (i32.add $value (i32.const 5))))
      (defgeneric $value ((object A) (value i32) i32))
      (defmethod $value ((object A) (value i32) i32) $value)
      (export-new C)
      (export-func value)
    `)] });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.value(exports["C.new"](), 7), 12);
    assert.include(wat, "(call $generic.value.A.impl (local.get $object)");
  });

  it("traps when a partial generic has no applicable method", async () => {
    const wat = await compileToWat({ sources: [source("partial.idle", `
      (defclass A)
      (defclass B (A))
      (defgeneric $value ((object A) i32))
      (defmethod $value ((object B) i32) (i32.const 9))
      (export-new A)
      (export-new B)
      (export-func value)
    `)] });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.value(exports["B.new"]()), 9);
    assert.throws(() => exports.value(exports["A.new"]()), WebAssembly.RuntimeError);
    assert.include(wat, "(func $generic.value.fallback");
  });

  it("requires the complete argument list for call-next-method", async () => {
    const cases = [
      "(call-next-method)",
      "(call-next-method $object)",
      "(call-next-method $object $value (i32.const 1))",
    ];
    for (const invocation of cases) {
      let error;
      try {
        await compileToWat({ sources: [source("next-arity.idle", `
          (defclass A)
          (defclass B (A))
          (defgeneric $value ((object A) (value i32) i32))
          (defmethod $value ((object A) (value i32) i32) $value)
          (defmethod $value ((object B) (value i32) i32) ${invocation})
        `)] });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, "CALL_NEXT_METHOD_ARITY", invocation);
    }
  });

  it("rejects call-next-method outside a method body", async () => {
    let error;
    try {
      await compileToWat({ sources: [source("outside-next.idle", `
        (defclass A)
        (defgeneric $value ((object A) i32))
        (func $bad (param $object (ref $A)) (result i32)
          (call-next-method $object))
      `)] });
    } catch (caught) {
      error = caught;
    }
    assert.strictEqual(error?.code, "CALL_NEXT_METHOD_OUTSIDE_METHOD");
  });

  it("runs additional user WAT macros inside raw method bodies", async () => {
    const wat = await compileToWat({
      macroModules: { helper: new URL("fixtures/macros/identity.wat", import.meta.url) },
      sources: [source("macro.idle", `
        (defclass Answer)
        (defgeneric $answer-read ((answer Answer) i32))
        (defmethod $answer-read ((answer Answer) i32)
          (helper:identity (i32.const 42)))
        (export-new Answer)
        (export-func answer-read)
      `)],
    });
    const exports = await instantiate(wat);

    assert.strictEqual(exports["answer-read"](exports["Answer.new"]()), 42);
  });

  it("runs the documented object and external macro example", async () => {
    const exampleBase = new URL("../example/article/", import.meta.url);
    const wat = await compileFilesToWat({
      inputPaths: [new URL("meter.idle", exampleBase)],
      macroModules: { demo: new URL("double.idle", exampleBase) },
    });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.main(), 44);
  });

  it("compiles and runs a macro module authored in Idle", async () => {
    const wat = await compileToWat({
      macroModules: { helper: new URL("fixtures/macros/idle-identity.idle", import.meta.url) },
      sources: [{
        name: "idle-macro.idle",
        text: `(module
          (func $answer (result i32) (helper:identity (i32.const 42)))
          (export "answer" (func $answer)))`,
      }],
    });
    const exports = await instantiate(wat);
    assert.strictEqual(exports.answer(), 42);
  });

  it("loads an Idle macro module through the CLI", async function () {
    this.timeout(5_000);
    const directory = await mkdtemp(join(tmpdir(), "idlec-macro-test-"));
    const input = join(directory, "main.idle");
    const output = join(directory, "main.wat");
    const macro = fileURLToPath(
      new URL("fixtures/macros/idle-identity.idle", import.meta.url),
    );
    try {
      await writeFile(input, `(module
        (func $answer (result i32) (helper:identity (i32.const 42)))
        (export "answer" (func $answer)))`);
      const result = await runCli(["--macro", `helper=${macro}`, input, "-o", output]);
      assert.strictEqual(result.code, 0, result.stderr);
      const exports = await instantiate(await readFile(output, "utf8"));
      assert.strictEqual(exports.answer(), 42);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports declaration errors with the originating source name", async () => {
    const cases = [
      ["(defclass)", "INVALID_DEFCLASS"],
      ["(defclass A (B C))", "MULTIPLE_SUPERCLASSES"],
      ["(defclass A (value i32))", "MULTIPLE_SUPERCLASSES"],
      ["(defclass A B)", "EXPECTED_PROPER_LIST"],
      ["(defclass A () x)", "EXPECTED_PROPER_LIST"],
      ["(defclass A () (x))", "INVALID_FIELD"],
      ["(defclass A () (x i32) (x i32))", "DUPLICATE_FIELD"],
      ["(defclass Child (Missing))", "UNKNOWN_PARENT"],
      ["(defclass A (B)) (defclass B (A))", "INHERITANCE_CYCLE"],
      ["(defclass A () (x i32)) (defclass B (A) (x i32))", "FIELD_SHADOWING"],
      ["(class A)", "CLASS_SYNTAX_REMOVED"],
      ["(defclass A) (export-method A old)", "EXPORT_METHOD_SYNTAX_REMOVED"],
      ["(defclass A) (defgeneric $f ((a A)))", "INVALID_GENERIC_SIGNATURE"],
      ["(defclass A) (defgeneric $f ((a A) i32)) (defgeneric $f ((a A) i32))", "DUPLICATE_GENERIC"],
      ["(defclass A) (defgeneric $f ((x A) (x i32) i32))", "DUPLICATE_PARAMETER"],
      ["(defclass A () (x i32)) (defgeneric $f ((a A) i32)) (defmethod $f ((a A) i32) (classes:set A x $a (i32.const 1)) (i32.const 0))", "IMMUTABLE_FIELD"],
      ["(defclass A) (defmethod $missing ((a A) i32) (i32.const 0))", "UNKNOWN_GENERIC"],
      ["(defgeneric $f ((x i32) i32))", "INVALID_DISPATCH_TYPE"],
      ["(defclass A) (defclass B) (defgeneric $f ((a A) i32)) (defmethod $f ((b B) i32) (i32.const 0))", "UNRELATED_METHOD_SPECIALIZER"],
      ["(defclass A) (defgeneric $f ((a A) i32)) (defmethod $f ((a A) i32) (i32.const 0)) (defmethod $f ((other A) i32) (i32.const 1))", "DUPLICATE_METHOD"],
      ["(defclass A) (defgeneric $f ((a A) i32)) (defun $f (i32) (i32.const 0))", "DUPLICATE_FUNCTION"],
      ["(defclass bad.name)", "INVALID_IDENTIFIER"],
      ["(defclass A) (defclass A)", "DUPLICATE_CLASS"],
    ];

    for (const [text, code] of cases) {
      let error;
      try {
        await compileToWat({ sources: [source("broken.idle", text)] });
      } catch (caught) {
        error = caught;
      }
      assert.strictEqual(error?.code, code, text);
      assert.strictEqual(error?.sourceName, "broken.idle", text);
    }
  });

  it("rejects malformed input and keeps generated validation context", async () => {
    let syntaxError;
    try {
      await compileToWat({ sources: [source("syntax.idle", "(")] });
    } catch (caught) {
      syntaxError = caught;
    }
    assert.strictEqual(syntaxError.code, "UNTERMINATED_LIST");
    assert.strictEqual(syntaxError.sourceName, "syntax.idle");

    let watError;
    try {
      await compileToWat({ sources: [source("wat.idle", "(func $bad (result i32))")] });
    } catch (caught) {
      watError = caught;
    }
    assert.strictEqual(watError.code, "GENERATED_WAT_INVALID");
    assert.include(watError.wat, "$bad");
  });

  it("writes CLI output atomically and preserves it after failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "idlec-test-"));
    const input = join(directory, "main.idle");
    const output = join(directory, "main.wat");
    try {
      await writeFile(input, "(module (func $main (result i32) (i32.const 9)) (export-func main))");
      const success = await runCli([input, "-o", output]);
      assert.strictEqual(success.code, 0, success.stderr);
      assert.include(await readFile(output, "utf8"), '(export "main"');

      await writeFile(input, "(");
      const failure = await runCli([input, "-o", output]);
      assert.notStrictEqual(failure.code, 0);
      assert.include(failure.stderr, "UNTERMINATED_LIST");
      assert.include(await readFile(output, "utf8"), '(export "main"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
