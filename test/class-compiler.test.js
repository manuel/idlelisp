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

  it("checks typed constructors, nominal upcasts, and inherited methods", async () => {
    const wat = await compileToWat({ sources: [source("typed-objects.idle", `
      (class A
        (method value () (result i32) (i32.const 7)))
      (class B (extends A))
      (typed-defun $make (A)
        ($B.new))
      (typed-defun $read (i32)
        (.value ($make)))
      (export-func read)
    `)] });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.read(), 7);
    assert.include(wat, "(call $B.new)");
    assert.include(wat, "(call $A.value.dispatch (call $make))");
  });

  it("infers virtual method dispatch from typed local declarations", async () => {
    const wat = await compileFilesToWat({
      inputPaths: [new URL("../benchmark/oop-list.idle", import.meta.url)],
    });
    const exports = await instantiate(wat);

    assert.strictEqual(exports.count(exports.build(0)), 0);
    assert.strictEqual(exports.count(exports.build(1)), 1);
    assert.strictEqual(exports.count(exports.build(37)), 37);
    assert.include(wat, "(call $List.is-empty.dispatch (local.get $cursor))");
    assert.include(wat, "(call $List.tail.dispatch (local.get $cursor))");
    assert.include(wat, "(local $cursor (ref $List))");
  });

  it("reports static errors in typed-defun before WAT validation", async () => {
    const cases = [
      ["(typed-defun $bad (() i32) 0)", "INVALID_TYPED_PARAMETER"],
      ["(typed-defun $bad (($value Missing) i32) 0)", "UNKNOWN_CHECKED_TYPE"],
      ["(typed-defun $bad (($value i32) i32) (set $value 1) $value)", "PARAMETER_ASSIGNMENT"],
      ["(typed-defun $bad (i32) (let $value i32 0) (let $value i32 1) $value)", "DUPLICATE_LOCAL"],
      ["(typed-defun $bad (i32) $missing)", "UNKNOWN_TYPED_LOCAL"],
      ["(typed-defun $bad (($value i32) i32) (.tail $value))", "NON_CLASS_RECEIVER"],
      ["(class A) (typed-defun $bad (($value A) i32) (.missing $value))", "UNKNOWN_TYPED_METHOD"],
      ["(class A (method f ((value i32)) (result i32) $value)) (typed-defun $bad (($a A) i32) (.f $a))", "TYPED_CALL_ARITY"],
      ["(typed-defun $bad (($value i32) i32) (i32.mul $value 2))", "UNSUPPORTED_TYPED_EXPRESSION"],
      ["(typed-defun $bad (($value i32) i32) (while $value (let $x i32 0)) 0)", "NESTED_TYPED_LOCAL"],
      ["(class A) (class B (extends A)) (typed-defun $bad (($value A) B) $value)", "TYPE_MISMATCH"],
      ["(class A (method f ((value i32)) (result i32) $value)) (class B (extends A) (override f () (result i32) (i32.const 0)))", "OVERRIDE_SIGNATURE_MISMATCH"],
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

  it("compiles cross-file inheritance, virtual calls, super calls, and mutation", async () => {
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
    assert.strictEqual(exports["Counter.read"](counter), 17);
    exports["Counter.write"](counter, 31);
    assert.strictEqual(exports["Counter.read"](counter), 31);
    assert.match(wat, /\$Counter\.read\.dispatch/);
    assert.notMatch(wat, /\$OffsetCounter\.read\.dispatch/);
  });

  it("supports virtual tail calls without growing the native stack", async () => {
    const wat = await compileToWat({ sources: [source("tail.idle", `
      (class Countdown
        (method run ((remaining i32))
          (result i32)
          (if (result i32)
            (i32.eqz (local.get $remaining))
            (then (i32.const 7))
            (else
              (classes:return-call Countdown run
                (local.get $this)
                (i32.sub (local.get $remaining) (i32.const 1)))))))
      (export-new Countdown)
      (export-method Countdown run)
    `)] });
    const exports = await instantiate(wat);

    assert.strictEqual(exports["Countdown.run"](exports["Countdown.new"](), 100_000), 7);
  });

  it("runs additional user WAT macros inside raw method bodies", async () => {
    const wat = await compileToWat({
      macroModules: { helper: new URL("fixtures/macros/identity.wat", import.meta.url) },
      sources: [source("macro.idle", `
        (class Answer
          (method read () (result i32)
            (helper:identity (i32.const 42))))
        (export-new Answer)
        (export-method Answer read)
      `)],
    });
    const exports = await instantiate(wat);

    assert.strictEqual(exports["Answer.read"](exports["Answer.new"]()), 42);
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
      ["(class Child (extends Missing))", "UNKNOWN_PARENT"],
      ["(class A (extends B)) (class B (extends A))", "INHERITANCE_CYCLE"],
      ["(class A (field x i32)) (class B (extends A) (field x i32))", "FIELD_SHADOWING"],
      ["(class A (override absent () (result)))", "UNKNOWN_OVERRIDE"],
      ["(class A (method f ((x i32) (x i32)) (result)))", "DUPLICATE_PARAMETER"],
      ["(class A (field x i32) (method f () (result) (classes:set A x (local.get $this) (i32.const 1))))", "IMMUTABLE_FIELD"],
      ["(class bad.name)", "INVALID_IDENTIFIER"],
      ["(class A) (class A)", "DUPLICATE_CLASS"],
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
