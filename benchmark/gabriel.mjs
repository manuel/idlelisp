import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { compileFilesToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";

const execFile = promisify(execFileCallback);
const sourcePath = new URL("gabriel.idle", import.meta.url);
const guilePath = new URL("guile-gabriel.scm", import.meta.url);
const javascriptPath = new URL("js-gabriel.mjs", import.meta.url);
const reportPath = new URL("gabriel-results.md", import.meta.url);
const objectPath = new URL("../build/objects.wasm", import.meta.url);
const names = ["deriv", "diviter", "divrec", "tak", "takl", "ntakl", "cpstak"];
const sampleCount = 5;
const warmups = 2;
// Fixed from the 2026-08-25 Guile calibration. Both engines use these counts.
const iterations = new Map([
  ["deriv", 1024],
  ["diviter", 64],
  ["divrec", 128],
  ["tak", 50],
  ["takl", 50],
  ["ntakl", 50],
  ["cpstak", 8],
]);

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

function elapsed(run, operations) {
  const start = performance.now();
  run(operations);
  return performance.now() - start;
}

function measure(name, run) {
  const operations = iterations.get(name);
  for (let index = 0; index < warmups; index += 1) run(operations);
  const timings = [];
  for (let index = 0; index < sampleCount; index += 1) {
    timings.push(elapsed(run, operations) / operations);
  }
  return { milliseconds: median(timings), operations };
}

function parseGuile(stdout) {
  const results = new Map();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("gabriel-result|")) continue;
    const [, name, operationsText, ...sampleTexts] = line.split("|");
    if (!names.includes(name)) continue;
    const operations = Number(operationsText);
    const timings = sampleTexts.map(Number);
    if (operations !== iterations.get(name)
        || timings.length !== sampleCount
        || timings.some((sample) => !Number.isFinite(sample))) {
      throw new Error(`invalid Guile result: ${line}`);
    }
    results.set(name, { milliseconds: median(timings), operations });
  }
  for (const name of names) {
    if (!results.has(name)) throw new Error(`Guile omitted ${name}`);
  }
  return results;
}

function format(milliseconds) {
  return milliseconds < 1
    ? `${(milliseconds * 1000).toFixed(2)} us`
    : `${milliseconds.toFixed(3)} ms`;
}

let compilationStart = performance.now();
const wat = await compileFilesToWat({ inputPaths: [sourcePath] });
const idleToWatMilliseconds = performance.now() - compilationStart;
const [{ default: binaryen }, objectBytes] = await Promise.all([
  import("binaryen"),
  readFile(objectPath),
]);
compilationStart = performance.now();
const parsed = binaryen.parseText(wat);
parsed.setFeatures(idleWasmFeatures(binaryen));
binaryen.setOptimizeLevel(4);
binaryen.setShrinkLevel(0);
parsed.optimize();
const benchmarkBytes = parsed.emitBinary();
parsed.dispose();
const watToWasmMilliseconds = performance.now() - compilationStart;

compilationStart = performance.now();
const benchmarkModule = await WebAssembly.compile(benchmarkBytes);
const v8CompileMilliseconds = performance.now() - compilationStart;

compilationStart = performance.now();
const { instance: objects } = await WebAssembly.instantiate(objectBytes);
const runtimeSetupMilliseconds = performance.now() - compilationStart;
const idleImports = {
  nil: objects.exports.abi_nil,
  is_nil: objects.exports.abi_is_nil,
  is_cons: objects.exports.abi_is_cons,
  cons: objects.exports.abi_cons,
  car: objects.exports.abi_car,
  cdr: objects.exports.abi_cdr,
  list_length: objects.exports.abi_list_length,
  intern: objects.exports.abi_intern,
};
compilationStart = performance.now();
const benchmark = await WebAssembly.instantiate(
  benchmarkModule,
  { idle: idleImports },
);
const idleInstantiateMilliseconds = performance.now() - compilationStart;
const wasm = benchmark.exports;
const expected = { diviter: 500, divrec: 500, tak: 7, takl: 7, ntakl: 7, cpstak: 4 };
for (const name of names) {
  if (name === "deriv") {
    if (wasm.valid_deriv() !== 1) throw new Error("deriv returned an invalid tree");
    continue;
  }
  const result = wasm[`benchmark_${name}`]();
  const actual = name === "tak" || name === "cpstak" ? result : wasm.list_length(result);
  if (actual !== expected[name]) throw new Error(`${name} returned ${actual}`);
}

const idle = new Map(names.map((name) => [name, measure(name, wasm[`repeat_${name}`])]));
compilationStart = performance.now();
const javascriptModule = await import(javascriptPath);
const javascriptSetupMilliseconds = performance.now() - compilationStart;
javascriptModule.checkResults();
let javascriptSink;
const javascript = new Map(names.map((name) => [name, measure(name, (operations) => {
  const run = javascriptModule.benchmarks.get(name);
  for (let index = 0; index < operations; index += 1) javascriptSink = run();
})]));
const compileDirectory = await mkdtemp(join(tmpdir(), "idle-guile-gabriel-"));
const guileArtifact = join(compileDirectory, "gabriel.go");
let guileCompileMilliseconds;
let stdout;
const externalArguments = [
  sampleCount,
  warmups,
  ...names.map((name) => iterations.get(name)),
].map(String);
try {
  const compileExpression = `(compile-file ${JSON.stringify(guilePath.pathname)} `
    + `#:output-file ${JSON.stringify(guileArtifact)})`;
  compilationStart = performance.now();
  await execFile("guile", ["-c", compileExpression], { maxBuffer: 4 * 1024 * 1024 });
  guileCompileMilliseconds = performance.now() - compilationStart;
  const runExpression = `(load-compiled ${JSON.stringify(guileArtifact)})`;
  ({ stdout } = await execFile(
    "guile",
    ["--r7rs", "-c", runExpression, ...externalArguments],
    { maxBuffer: 4 * 1024 * 1024 },
  ));
} finally {
  await rm(compileDirectory, { recursive: true, force: true });
}
const guile = parseGuile(stdout);

const guileRelativeScores = names.map((name) => (
  idle.get(name).milliseconds / guile.get(name).milliseconds
));
const javascriptRelativeScores = names.map((name) => (
  idle.get(name).milliseconds / javascript.get(name).milliseconds
));
const guileOverallScore = median(guileRelativeScores);
const javascriptOverallScore = median(javascriptRelativeScores);
const report = [
  "# Gabriel benchmark",
  "",
  `Node ${process.version}. Each engine gets ${warmups} warmup batches and ${sampleCount} measured batches. `
    + "Both engines run the same fixed iteration count for each benchmark. Compilation is excluded from execution timings.",
  "",
  "## Execution",
  "",
  "| Benchmark | Iterations | Idle/op | Guile/op | JavaScript/op | Idle relative | Guile relative | JavaScript relative |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  ...names.map((name) => {
    const idleResult = idle.get(name);
    const guileResult = guile.get(name);
    const javascriptResult = javascript.get(name);
    return `| ${name} | ${idleResult.operations} | ${format(idleResult.milliseconds)} | `
      + `${format(guileResult.milliseconds)} | ${format(javascriptResult.milliseconds)} | 1.00 | `
      + `${(idleResult.milliseconds / guileResult.milliseconds).toFixed(2)} | `
      + `${(idleResult.milliseconds / javascriptResult.milliseconds).toFixed(2)} |`;
  }),
  "",
  `Assessment: Guile's median relative score is ${guileOverallScore.toFixed(2)} and JavaScript's is `
    + `${javascriptOverallScore.toFixed(2)}, against Idle at 1.00. A score above 1.00 means that engine is faster than Idle; below 1.00 means it is slower.`,
  "",
  "## Compilation and setup",
  "",
  "| Compiler | Stage | Time |",
  "|---|---|---:|",
  `| Idle | .idle to validated WAT | ${format(idleToWatMilliseconds)} |`,
  `| Idle | Binaryen -O4 optimization + Wasm emission | ${format(watToWasmMilliseconds)} |`,
  `| Idle | V8 compile Wasm | ${format(v8CompileMilliseconds)} |`,
  `| Idle | instantiate + initialize | ${format(idleInstantiateMilliseconds)} |`,
  `| Idle | prebuilt object-runtime setup | ${format(runtimeSetupMilliseconds)} |`,
  `| Guile | source to fresh .go (new process) | ${format(guileCompileMilliseconds)} |`,
  `| JavaScript | module load + initialization | ${format(javascriptSetupMilliseconds)} |`,
];
const markdown = `${report.join("\n")}\n`;
await writeFile(reportPath, markdown);
console.log(markdown.trimEnd());
