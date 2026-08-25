import { assert } from "chai";

import {
  createJsImplementation,
  createWasmImplementation,
  formatResults,
  parseArguments,
  runComparison,
} from "../benchmark/oop.mjs";

function verifyImplementation(implementation) {
  for (const length of [0, 1, 17, 1_000]) {
    const list = implementation.build(length);
    assert.strictEqual(implementation.count(list), length);
    assert.strictEqual(implementation.buildAndCount(length), length);
  }
}

describe("OOP linked-list benchmark", () => {
  it("performs equivalent JavaScript and Wasm-GC workloads", async () => {
    verifyImplementation(createJsImplementation());
    verifyImplementation(await createWasmImplementation());
  });

  it("validates benchmark arguments", () => {
    assert.deepInclude(parseArguments(["--length", "123", "--samples", "3"]), {
      length: 123,
      samples: 3,
    });
    assert.throws(() => parseArguments(["--length", "0"]), "positive signed i32");
    assert.throws(() => parseArguments(["--length", "2147483648"]), "positive signed i32");
    assert.throws(() => parseArguments(["--unknown"]), "unknown option");
  });

  it("produces machine-readable child results and a comparison table", async function () {
    this.timeout(10_000);
    const options = parseArguments([
      "--length", "100",
      "--warmup-ms", "1",
      "--sample-ms", "1",
      "--samples", "1",
    ]);
    const result = await runComparison(options);
    for (const engine of ["wasm", "js"]) {
      assert.strictEqual(result[engine].length, 100);
      for (const workload of ["construct", "traverse", "construct + traverse"]) {
        assert.isAbove(result[engine].workloads[workload].medianMs, 0);
      }
    }
    assert.include(formatResults(result), "wasm vs js");
  });
});
