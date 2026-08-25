#!/usr/bin/env node

import { execFile } from "node:child_process";
import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { compileFilesToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";

const executeFile = promisify(execFile);
const benchmarkPath = fileURLToPath(import.meta.url);
const sourcePath = new URL("oop-list.idle", import.meta.url);
const WORKLOAD_NAMES = ["construct", "traverse", "construct + traverse"];

export function parseArguments(arguments_) {
  const options = {
    engine: undefined,
    json: false,
    length: 100_000,
    warmupMs: 500,
    sampleMs: 250,
    samples: 9,
  };
  const names = new Map([
    ["--length", "length"],
    ["--warmup-ms", "warmupMs"],
    ["--sample-ms", "sampleMs"],
    ["--samples", "samples"],
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--engine") {
      const engine = arguments_[index += 1];
      if (engine !== "wasm" && engine !== "js") throw new Error("--engine must be wasm or js");
      options.engine = engine;
    } else if (names.has(argument)) {
      const text = arguments_[index += 1];
      if (text === undefined || !/^[0-9]+$/.test(text)) throw new Error(`${argument} requires an integer`);
      options[names.get(argument)] = Number(text);
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  if (!Number.isSafeInteger(options.length) || options.length < 1 || options.length > 0x7fff_ffff) {
    throw new Error("--length must be a positive signed i32");
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw new Error("--samples must be a positive safe integer");
  }
  for (const name of ["warmupMs", "sampleMs"]) {
    if (!Number.isFinite(options[name]) || options[name] < 1) {
      throw new Error(`--${name === "warmupMs" ? "warmup" : "sample"}-ms must be positive`);
    }
  }
  return options;
}

class List {
  isEmpty() {
    return 1;
  }

  tail() {
    return this;
  }
}

class Nil extends List {
  constructor() {
    super();
    this.sentinel = 0;
  }

  sentinelValue() {
    return this.sentinel;
  }
}

class Node extends List {
  constructor(next) {
    super();
    this.nextValue = next;
  }

  isEmpty() {
    return 0;
  }

  tail() {
    return this.nextValue;
  }
}

export function createJsImplementation() {
  function build(size) {
    let list = new Nil();
    for (let remaining = size; remaining !== 0; remaining -= 1) {
      list = new Node(list);
    }
    return list;
  }

  function count(list) {
    let length = 0;
    let cursor = list;
    while (!cursor.isEmpty()) {
      cursor = cursor.tail();
      length += 1;
    }
    return length;
  }

  return {
    build,
    count,
    buildAndCount: (size) => count(build(size)),
  };
}

export async function createWasmImplementation() {
  const wat = await compileFilesToWat({ inputPaths: [sourcePath] });
  const { default: binaryen } = await import("binaryen");
  const module = binaryen.parseText(wat);
  try {
    module.setFeatures(idleWasmFeatures(binaryen));
    if (!module.validate()) throw new Error("benchmark module did not validate");
    const { instance } = await WebAssembly.instantiate(module.emitBinary());
    return {
      build: instance.exports.build,
      count: instance.exports.count,
      buildAndCount: instance.exports["build-and-count"],
    };
  } finally {
    module.dispose();
  }
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

let blackhole;

function execute(operation, iterations) {
  for (let index = 0; index < iterations; index += 1) blackhole = operation();
}

function elapsed(operation, iterations) {
  const start = performance.now();
  execute(operation, iterations);
  return performance.now() - start;
}

function warm(operation, durationMs) {
  const deadline = performance.now() + durationMs;
  do {
    execute(operation, 1);
  } while (performance.now() < deadline);
}

function calibratedIterations(operation, targetMs) {
  let iterations = 1;
  let duration = elapsed(operation, iterations);
  while (duration < 20 && iterations < 1_048_576) {
    iterations *= 2;
    duration = elapsed(operation, iterations);
  }
  return Math.max(1, Math.ceil(iterations * targetMs / Math.max(duration, 0.001)));
}

function measure(operation, options) {
  warm(operation, options.warmupMs);
  const iterations = calibratedIterations(operation, options.sampleMs);
  const samples = [];
  for (let sample = 0; sample < options.samples; sample += 1) {
    blackhole = undefined;
    globalThis.gc?.();
    samples.push(elapsed(operation, iterations) / iterations);
  }
  return { medianMs: median(samples), iterations, samplesMs: samples };
}

export async function runEngine(engine, options) {
  const implementation = engine === "wasm"
    ? await createWasmImplementation()
    : createJsImplementation();
  for (const size of [0, 1, options.length]) {
    const list = implementation.build(size);
    if (implementation.count(list) !== size || implementation.buildAndCount(size) !== size) {
      throw new Error(`${engine} linked-list correctness check failed at length ${size}`);
    }
  }
  const list = implementation.build(options.length);
  const operations = {
    construct: () => implementation.build(options.length),
    traverse: () => implementation.count(list),
    "construct + traverse": () => implementation.buildAndCount(options.length),
  };
  return {
    engine,
    length: options.length,
    workloads: Object.fromEntries(
      WORKLOAD_NAMES.map((name) => [name, measure(operations[name], options)]),
    ),
  };
}

function numericArguments(options) {
  return [
    "--length", String(options.length),
    "--warmup-ms", String(options.warmupMs),
    "--sample-ms", String(options.sampleMs),
    "--samples", String(options.samples),
  ];
}

async function runChild(engine, options) {
  const { stdout } = await executeFile(process.execPath, [
    "--expose-gc",
    benchmarkPath,
    "--engine", engine,
    "--json",
    ...numericArguments(options),
  ], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function comparison(wasmMs, jsMs) {
  const ratio = wasmMs / jsMs;
  return ratio <= 1
    ? `${(1 / ratio).toFixed(2)}x faster`
    : `${ratio.toFixed(2)}x slower`;
}

function formatMilliseconds(value) {
  return value < 0.01 ? value.toFixed(4) : value.toFixed(3);
}

export function formatResults(result) {
  const rows = WORKLOAD_NAMES.map((name) => {
    const wasmMs = result.wasm.workloads[name].medianMs;
    const jsMs = result.js.workloads[name].medianMs;
    return [name, formatMilliseconds(wasmMs), formatMilliseconds(jsMs), comparison(wasmMs, jsMs)];
  });
  const widths = ["workload", "wasm-gc ms", "js/v8 ms", "wasm vs js"].map(
    (heading, index) => Math.max(heading.length, ...rows.map((row) => row[index].length)),
  );
  const line = (values) => values.map((value, index) => value.padEnd(widths[index])).join("  ");
  return [
    `Node ${process.versions.node}, V8 ${process.versions.v8}`,
    `List length ${result.length.toLocaleString("en-US")}; median of ${result.samples} samples`,
    line(["workload", "wasm-gc ms", "js/v8 ms", "wasm vs js"]),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ].join("\n");
}

export async function runComparison(options) {
  const wasm = await runChild("wasm", options);
  const js = await runChild("js", options);
  return {
    length: options.length,
    warmupMs: options.warmupMs,
    sampleMs: options.sampleMs,
    samples: options.samples,
    node: process.versions.node,
    v8: process.versions.v8,
    wasm,
    js,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = options.engine === undefined
    ? await runComparison(options)
    : await runEngine(options.engine, options);
  writeSync(1, `${options.json ? JSON.stringify(result) : formatResults(result)}\n`);
}

if (process.argv[1] !== undefined
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    writeSync(2, `${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
