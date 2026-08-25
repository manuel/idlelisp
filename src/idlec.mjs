#!/usr/bin/env node

import { rename, unlink, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compileFilesToWat } from "./class-compiler.mjs";

function usage() {
  return "usage: idlec [--macro NAME=PATH ...] INPUT.idle [INPUT.idle ...] -o OUTPUT.wat";
}

async function main(arguments_) {
  const inputs = [];
  const macroModules = new Map();
  let output;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "-o") {
      if (output !== undefined || index + 1 >= arguments_.length) throw new Error(usage());
      output = arguments_[index += 1];
    } else if (argument === "--macro") {
      if (index + 1 >= arguments_.length) throw new Error(usage());
      const specification = arguments_[index += 1];
      const separator = specification.indexOf("=");
      if (separator <= 0 || separator === specification.length - 1) throw new Error(usage());
      const name = specification.slice(0, separator);
      if (macroModules.has(name)) throw new Error(`duplicate macro module ${name}`);
      macroModules.set(name, pathToFileURL(resolve(specification.slice(separator + 1))));
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option ${argument}\n${usage()}`);
    } else {
      inputs.push(argument);
    }
  }
  if (inputs.length === 0 || output === undefined) throw new Error(usage());

  const wat = await compileFilesToWat({ inputPaths: inputs, macroModules });
  const outputPath = resolve(output);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, wat);
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

main(process.argv.slice(2)).catch((error) => {
  const location = error.sourceName === undefined ? "" : `${error.sourceName}: `;
  const offset = error.byteOffset === undefined ? "" : ` at byte ${error.byteOffset}`;
  writeSync(2, `${location}${error.code ?? error.name}: ${error.message}${offset}\n`);
  process.exitCode = 1;
});
