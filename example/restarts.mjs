import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import binaryen from "binaryen";

import { compileFilesToWat } from "../src/class-compiler.mjs";
import { idleWasmFeatures } from "../src/wasm-features.mjs";

const jspiFlag = "--experimental-wasm-stack-switching";
if (typeof WebAssembly.Suspending !== "function"
    && !process.execArgv.includes(jspiFlag)) {
  const child = spawnSync(
    process.execPath,
    [jspiFlag, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (child.error !== undefined) throw child.error;
  process.exit(child.status ?? 1);
}
if (typeof WebAssembly.Suspending !== "function"
    || typeof WebAssembly.promising !== "function") {
  throw new Error("this Node.js build does not expose the current JSPI API");
}

const wat = await compileFilesToWat({
  inputPaths: [new URL("restarts.idle", import.meta.url)],
});
const module = binaryen.parseText(wat);
let binary;
try {
  module.setFeatures(idleWasmFeatures(binaryen));
  if (!module.validate()) throw new Error("the restart demo did not validate");
  binary = module.emitBinary();
} finally {
  module.dispose();
}

const { instance: { exports: objects } } = await WebAssembly.instantiate(
  await readFile(new URL("../build/objects.wasm", import.meta.url)),
);

function decodeString(value) {
  const length = objects.abi_string_length(value);
  const bytes = Uint8Array.from(
    { length },
    (_, index) => objects.abi_string_byte(value, index),
  );
  return new TextDecoder().decode(bytes);
}

function restartChoices(list) {
  const choices = [];
  let cursor = list;
  while (objects.abi_is_nil(cursor) === 0) {
    const symbol = objects.abi_car(cursor);
    choices.push({ symbol, name: decodeString(objects.abi_symbol_name(symbol)) });
    cursor = objects.abi_cdr(cursor);
  }
  return choices;
}

const terminal = createInterface({ input: stdin, output: stdout });
const chooseRestart = new WebAssembly.Suspending(async (available) => {
  const choices = restartChoices(available);
  if (choices.length === 0) throw new Error("no restart is available");

  stdout.write("The dragon-powered toaster failed. Available restarts:\n");
  choices.forEach(({ name }, index) => {
    stdout.write(`  ${index + 1}) ${name}\n`);
  });

  while (true) {
    const answer = await terminal.question(`Choose 1-${choices.length}: `);
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      return choices[index].symbol;
    }
    stdout.write("Please enter one of the displayed numbers.\n");
  }
});

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

try {
  const { instance } = await WebAssembly.instantiate(binary, {
    idle,
    demo: { choose_restart: chooseRestart },
  });
  const result = await WebAssembly.promising(instance.exports.main)();
  stdout.write(`Result: ${decodeString(result)}\n`);
} finally {
  terminal.close();
}
