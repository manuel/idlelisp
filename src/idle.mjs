import { readFile } from "node:fs/promises";

import { idleWasmFeatures } from "./wasm-features.mjs";

const PAGE_BYTES = 65_536;

const KIND_NAMES = Object.freeze([
  "invalid",
  "integer",
  "boolean",
  "string",
  "symbol",
  "cons",
  "nil",
  "object",
]);

const ERROR_NAMES = Object.freeze([
  "",
  "UNEXPECTED_CLOSE",
  "UNTERMINATED_LIST",
  "MISSING_QUOTED_DATUM",
  "UNKNOWN_SHARP_SYNTAX",
  "INTEGER_OVERFLOW",
  "DOTTED_LIST_UNSUPPORTED",
  "READER_SYNTAX_UNSUPPORTED",
  "INVALID_QUALIFIED_SYMBOL",
  "UNTERMINATED_STRING",
  "INVALID_STRING_ESCAPE",
]);

const MACRO_IMPORT_NAMES = Object.freeze([
  "nil",
  "is_nil",
  "cons",
  "is_cons",
  "car",
  "cdr",
  "set_car",
  "set_cdr",
  "list_length",
  "list_reverse_prepend",
  "integer",
  "is_integer",
  "integer_value",
  "boolean",
  "is_boolean",
  "boolean_value",
  "string",
  "is_string",
  "string_length",
  "string_byte",
  "string_set_byte",
  "intern",
  "intern_qualified",
  "is_symbol",
  "symbol_has_module",
  "symbol_module",
  "symbol_name",
  "equal",
  "is_hashable",
  "hash",
]);

const BUILT_IN_MACRO_NAMES = new Set(["classes", "condition", "control", "dynamic", "list"]);

function requireKind(api, value, expected) {
  const actual = api.kind(value);
  if (actual !== expected) {
    throw new TypeError(`expected ${expected}, got ${actual}`);
  }
}

function contextualError(code, message, context = {}) {
  const error = new Error(message, context.cause === undefined ? undefined : { cause: context.cause });
  error.code = code;
  if (context.moduleName !== undefined) error.moduleName = context.moduleName;
  if (context.macroName !== undefined) error.macroName = context.macroName;
  return error;
}

function isIdlePath(path) {
  const name = path instanceof URL ? path.pathname : String(path);
  return name.endsWith(".idle");
}

export async function createReader({
  wasmPath = new URL("../build/objects.wasm", import.meta.url),
  macroModules = {},
  macroHostFactory,
} = {}) {
  const { instance } = await WebAssembly.instantiate(await readFile(wasmPath));
  const wasm = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function bytes() {
    return new Uint8Array(wasm.memory.buffer);
  }

  function stageText(value) {
    const encoded = encoder.encode(value);
    if (encoded.byteLength > wasm.memory.buffer.byteLength) {
      const missing = encoded.byteLength - wasm.memory.buffer.byteLength;
      wasm.memory.grow(Math.ceil(missing / PAGE_BYTES));
    }
    bytes().set(encoded, 0);
    return encoded.byteLength;
  }

  function internPlain(name) {
    return wasm.intern_memory(0, stageText(name));
  }

  function internQualified(moduleSymbol, name) {
    return wasm.intern_memory_module(moduleSymbol, 0, stageText(name));
  }

  function symbolLocalName(value) {
    const byteLength = wasm.symbol_name_to_memory(value);
    return decoder.decode(bytes().subarray(0, byteLength));
  }

  const macroRegistry = new Map();
  const usedMacroModules = new Set();
  const quoteSymbol = internPlain("quote");
  const macroHostImports = macroHostFactory?.({
    wasm,
    internPlain,
    internQualified,
    symbolLocalName,
  }) ?? {};

  const moduleEntries = macroModules instanceof Map
    ? [...macroModules.entries()]
    : Object.entries(macroModules);

  if (moduleEntries.length > 0) {
    const { default: binaryen } = await import("binaryen");
    const features = idleWasmFeatures(binaryen);
    const idleImports = Object.fromEntries(
      MACRO_IMPORT_NAMES.map((name) => [name, wasm[`abi_${name}`]]),
    );
    Object.assign(idleImports, macroHostImports);

    for (const [moduleName, watPath] of moduleEntries) {
      if (typeof moduleName !== "string" || moduleName.length === 0 || moduleName.includes(":")) {
        throw contextualError(
          "INVALID_MACRO_MODULE_NAME",
          `invalid macro module name: ${String(moduleName)}`,
          { moduleName },
        );
      }

      let wat;
      if (isIdlePath(watPath)) {
        try {
          const { compileFilesToWat } = await import("./class-compiler.mjs");
          wat = await compileFilesToWat({
            inputPaths: [watPath],
            excludedBuiltInMacros: BUILT_IN_MACRO_NAMES.has(moduleName)
              ? [moduleName]
              : [],
          });
        } catch (cause) {
          throw contextualError(
            "MACRO_MODULE_COMPILE_FAILED",
            `could not compile macro module ${moduleName}`,
            { moduleName, cause },
          );
        }
      } else {
        try {
          wat = await readFile(watPath, "utf8");
        } catch (cause) {
          throw contextualError(
            "MACRO_MODULE_READ_FAILED",
            `could not read macro module ${moduleName}`,
            { moduleName, cause },
          );
        }
      }

      let binary;
      try {
        const parsed = binaryen.parseText(wat);
        parsed.setFeatures(features);
        if (!parsed.validate()) throw new Error("macro module did not validate");
        binary = parsed.emitBinary();
        parsed.dispose();
      } catch (cause) {
        throw contextualError(
          "MACRO_MODULE_COMPILE_FAILED",
          `could not compile macro module ${moduleName}`,
          { moduleName, cause },
        );
      }

      let macroInstance;
      try {
        ({ instance: macroInstance } = await WebAssembly.instantiate(binary, { idle: idleImports }));
      } catch (cause) {
        throw contextualError(
          "MACRO_MODULE_INSTANTIATE_FAILED",
          `could not instantiate macro module ${moduleName}`,
          { moduleName, cause },
        );
      }

      const moduleSymbol = internPlain(moduleName);
      let macroCount = 0;
      for (const [exportName, expander] of Object.entries(macroInstance.exports)) {
        if (!exportName.startsWith("macro:")) continue;
        const macroName = exportName.slice(6);
        if (macroName.length === 0 || macroName.includes(":") || typeof expander !== "function") {
          throw contextualError(
            "INVALID_MACRO_EXPORT",
            `invalid macro export ${exportName} in ${moduleName}`,
            { moduleName, macroName },
          );
        }
        const symbol = internQualified(moduleSymbol, macroName);
        if (macroRegistry.has(symbol)) {
          throw contextualError(
            "DUPLICATE_MACRO",
            `duplicate macro ${moduleName}:${macroName}`,
            { moduleName, macroName },
          );
        }
        macroRegistry.set(symbol, { expander, moduleName, macroName });
        macroCount += 1;
      }
      if (macroCount === 0) {
        throw contextualError(
          "EMPTY_MACRO_MODULE",
          `macro module ${moduleName} exports no macros`,
          { moduleName },
        );
      }
    }
  }

  function expandOuter(initial) {
    let value = initial;
    while (wasm.is_cons(value)) {
      const head = wasm.cons_car(value);
      if (!wasm.is_symbol(head)) break;
      const macro = macroRegistry.get(head);
      if (macro === undefined) {
        if (wasm.symbol_has_module(head)) {
          const moduleName = symbolLocalName(wasm.symbol_module(head));
          const macroName = symbolLocalName(head);
          throw contextualError(
            "UNKNOWN_MACRO",
            `unknown macro ${moduleName}:${macroName}`,
            { moduleName, macroName },
          );
        }
        break;
      }
      try {
        usedMacroModules.add(macro.moduleName);
        value = macro.expander(value);
      } catch (cause) {
        if (cause?.idleMacroError) throw cause;
        throw contextualError(
          "MACRO_EXPANDER_FAILED",
          `macro ${macro.moduleName}:${macro.macroName} failed`,
          { moduleName: macro.moduleName, macroName: macro.macroName, cause },
        );
      }
    }
    return value;
  }

  function expandForm(root) {
    let result = root;
    const tasks = [{ type: "form", value: root, assign: (value) => { result = value; } }];
    while (tasks.length > 0) {
      const task = tasks.pop();
      if (task.type === "list") {
        if (wasm.is_nil(task.cursor)) continue;
        const cell = task.cursor;
        tasks.push({ type: "list", cursor: wasm.cons_cdr(cell) });
        tasks.push({
          type: "form",
          value: wasm.cons_car(cell),
          assign: (value) => wasm.set_cons_car(cell, value),
        });
        continue;
      }

      const value = expandOuter(task.value);
      task.assign(value);
      if (!wasm.is_cons(value)) continue;
      if (wasm.cons_car(value) === quoteSymbol) continue;
      tasks.push({ type: "list", cursor: value });
    }
    return result;
  }

  function expandTopLevel(forms) {
    let cursor = forms;
    while (!wasm.is_nil(cursor)) {
      const cell = cursor;
      wasm.set_cons_car(cell, expandForm(wasm.cons_car(cell)));
      cursor = wasm.cons_cdr(cell);
    }
    return forms;
  }

  const api = {
    readAll(source) {
      if (typeof source !== "string") {
        throw new TypeError("source must be a string");
      }

      const byteLength = stageText(source);
      const result = wasm.read_all(byteLength);
      if (!wasm.reader_result_ok(result)) {
        const number = wasm.reader_result_error_code(result);
        const error = new SyntaxError(ERROR_NAMES[number] ?? `READER_ERROR_${number}`);
        error.code = ERROR_NAMES[number] ?? `READER_ERROR_${number}`;
        error.byteOffset = wasm.reader_result_error_offset(result);
        throw error;
      }
      return wasm.reader_result_value(result);
    },

    kind(value) {
      return KIND_NAMES[wasm.value_kind(value)] ?? "invalid";
    },

    car(value) {
      requireKind(api, value, "cons");
      return wasm.cons_car(value);
    },

    cdr(value) {
      requireKind(api, value, "cons");
      return wasm.cons_cdr(value);
    },

    setCar(value, replacement) {
      requireKind(api, value, "cons");
      wasm.set_cons_car(value, replacement);
      return value;
    },

    setCdr(value, replacement) {
      requireKind(api, value, "cons");
      wasm.set_cons_cdr(value, replacement);
      return value;
    },

    integerValue(value) {
      requireKind(api, value, "integer");
      return wasm.integer_value(value);
    },

    booleanValue(value) {
      requireKind(api, value, "boolean");
      return Boolean(wasm.bool_to_i32(value));
    },

    symbolName(value) {
      requireKind(api, value, "symbol");
      return symbolLocalName(value);
    },

    symbolModuleName(value) {
      requireKind(api, value, "symbol");
      if (!wasm.symbol_has_module(value)) return null;
      return symbolLocalName(wasm.symbol_module(value));
    },

    stringBytes(value) {
      requireKind(api, value, "string");
      const length = wasm.abi_string_length(value);
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        result[index] = wasm.abi_string_byte(value, index);
      }
      return result;
    },

    macroexpand(form) {
      return expandForm(form);
    },

    macroexpandAll(forms) {
      if (!wasm.is_nil(forms) && !wasm.is_cons(forms)) {
        throw new TypeError("forms must be a proper top-level list");
      }
      return expandTopLevel(forms);
    },

    get usedMacroModules() {
      return new Set(usedMacroModules);
    },

    eq(first, second) {
      return Boolean(wasm.is_equal(first, second));
    },

    isHashable(value) {
      return Boolean(wasm.is_hashable(value));
    },

    hash(value) {
      if (!wasm.is_hashable(value)) {
        throw new TypeError(`cannot hash ${api.kind(value)}`);
      }
      return wasm.hash(value);
    },
  };

  return api;
}
