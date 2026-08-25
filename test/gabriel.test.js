import { assert } from "chai";
import { readFile } from "node:fs/promises";

import { compileFilesToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";
import { benchmarks as javascriptBenchmarks, checkResults as checkJavaScriptResults } from "../benchmark/js-gabriel.mjs";

describe("Gabriel benchmarks", () => {
  it("runs the JavaScript workloads with equivalent results", () => {
    assert.doesNotThrow(checkJavaScriptResults);
    assert.deepEqual(
      [...javascriptBenchmarks.keys()],
      ["deriv", "diviter", "divrec", "tak", "takl", "ntakl", "cpstak"],
    );
  });

  it("runs the ported workloads with the existing cons runtime", async () => {
    const wat = await compileFilesToWat({
      inputPaths: [new URL("../benchmark/gabriel.idle", import.meta.url)],
    });
    const [{ default: binaryen }, objectBytes] = await Promise.all([
      import("binaryen"),
      readFile(new URL("../build/objects.wasm", import.meta.url)),
    ]);
    const module = binaryen.parseText(wat);
    try {
      module.setFeatures(idleWasmFeatures(binaryen));
      assert.isOk(module.validate());
      const { instance: objects } = await WebAssembly.instantiate(objectBytes);
      const { instance } = await WebAssembly.instantiate(module.emitBinary(), {
        idle: {
          nil: objects.exports.abi_nil,
          is_nil: objects.exports.abi_is_nil,
          is_cons: objects.exports.abi_is_cons,
          cons: objects.exports.abi_cons,
          car: objects.exports.abi_car,
          cdr: objects.exports.abi_cdr,
          list_length: objects.exports.abi_list_length,
          intern: objects.exports.abi_intern,
        },
      });
      const wasm = instance.exports;
      assert.strictEqual(wasm.valid_deriv(), 1);
      assert.strictEqual(wasm.list_length(wasm.benchmark_diviter()), 500);
      assert.strictEqual(wasm.list_length(wasm.benchmark_divrec()), 500);
      assert.strictEqual(wasm.benchmark_tak(), 7);
      assert.strictEqual(wasm.list_length(wasm.benchmark_takl()), 7);
      assert.strictEqual(wasm.list_length(wasm.benchmark_ntakl()), 7);
      assert.strictEqual(wasm.benchmark_cpstak(), 4);
    } finally {
      module.dispose();
    }
  });
});
