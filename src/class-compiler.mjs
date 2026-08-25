import { readFile } from "node:fs/promises";

import { createClassMacroHost } from "./class-macros.mjs";
import { createReader } from "./idle.mjs";
import { idleWasmFeatures } from "./wasm-features.mjs";

const classesPath = new URL("classes.wat", import.meta.url);
const controlPath = new URL("control.idle", import.meta.url);
const dynamicPath = new URL("dynamic.idle", import.meta.url);
const listPath = new URL("list.idle", import.meta.url);
const dynamicRuntimePath = new URL("dynamic-runtime.idle", import.meta.url);
const conditionPath = new URL("condition.idle", import.meta.url);
const conditionRuntimePath = new URL("condition-runtime.idle", import.meta.url);
const CLASS_DSL_HEADS = new Set([
  "defclass",
  "class",
  "defgeneric",
  "defmethod",
  "export-new",
  "export-method",
  "export-func",
]);
const STRING_LITERAL_TYPE = "$idle.string-data";
const STRING_LITERAL_GLOBAL_PREFIX = "$idle.string.";
const SYMBOL_LITERAL_GLOBAL_PREFIX = "$idle.symbol.";
const SYMBOL_INTERN_FUNCTION = "$idle.intern";
const SYMBOL_INITIALIZER_FUNCTION = "$idle.initialize-symbols";
const GENERATED_START_FUNCTION = "$idle.start";
const NIL_FUNCTION = "$idle.nil";
const FUNCTION_DECLARATION_HEADS = new Set(["export", "local", "param", "result", "type"]);
const OPERANDS_NONE = Object.freeze({ mode: "none" });
const OPERANDS_ALL = Object.freeze({ mode: "all" });
const OPERANDS_LAST = Object.freeze({ mode: "last" });
const OPERANDS_AFTER_ONE = Object.freeze({ mode: "after", count: 1 });
const OPERANDS_AFTER_TWO = Object.freeze({ mode: "after", count: 2 });
const OPERANDS_AFTER_THREE = Object.freeze({ mode: "after", count: 3 });
const OPERANDS_AFTER_OPTIONAL_NAME = Object.freeze({ mode: "afterOptionalName" });
const WAT_OPERAND_POLICIES = new Map([
  ...[
    "data", "elem", "export", "field", "global.get", "i32.const", "i64.const",
    "f32.const", "f64.const", "import", "local", "local.get", "memory", "mut",
    "param", "rec", "ref", "ref.func", "ref.null", "result", "start", "struct",
    "sub", "table", "tag", "type",
  ].map((head) => [head, OPERANDS_NONE]),
  ...[
    "br", "br_if", "call", "call_ref", "catch", "global.set", "local.set", "local.tee",
    "ref.cast", "ref.test", "return_call", "return_call_ref", "struct.new", "throw",
  ].map((head) => [head, OPERANDS_AFTER_ONE]),
  ...[
    "struct.get", "struct.get_s", "struct.get_u", "struct.set",
  ].map((head) => [head, OPERANDS_AFTER_TWO]),
  ...[
    "br_on_cast", "br_on_cast_fail",
  ].map((head) => [head, OPERANDS_AFTER_THREE]),
  ...[
    "block", "func", "if", "loop", "try",
  ].map((head) => [head, OPERANDS_AFTER_OPTIONAL_NAME]),
  ["global", OPERANDS_LAST],
  ["br_table", OPERANDS_LAST],
  ["module", OPERANDS_ALL],
]);

function compilerError(code, message, context = {}) {
  const error = new Error(message, context.cause === undefined ? undefined : { cause: context.cause });
  error.name = "IdleCompilerError";
  error.code = code;
  Object.assign(error, context);
  return error;
}

function listValues(idle, value) {
  const result = [];
  let cursor = value;
  while (idle.kind(cursor) !== "nil") {
    if (idle.kind(cursor) !== "cons") {
      throw compilerError("IMPROPER_WAT_LIST", "expanded WAT contains an improper list");
    }
    result.push(idle.car(cursor));
    cursor = idle.cdr(cursor);
  }
  return result;
}

function escapeWatBytes(bytes) {
  let result = "\"";
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c) {
      result += String.fromCharCode(byte);
    } else if (byte === 0x22) {
      result += "\\\"";
    } else if (byte === 0x5c) {
      result += "\\\\";
    } else {
      result += `\\${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return `${result}\"`;
}

function escapeIdleString(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function plainSymbolName(idle, value) {
  if (idle.kind(value) !== "symbol" || idle.symbolModuleName(value) !== null) return undefined;
  return idle.symbolName(value);
}

function byteKey(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function createStringLiteralPool() {
  const entries = [];
  const indexes = new Map();
  return {
    entries,
    intern(bytes) {
      const key = byteKey(bytes);
      let index = indexes.get(key);
      if (index === undefined) {
        index = entries.length;
        indexes.set(key, index);
        entries.push(Uint8Array.from(bytes));
      }
      return index;
    },
  };
}

function createSymbolLiteralPool(stringPool) {
  const entries = [];
  const indexes = new Map();
  const encoder = new TextEncoder();
  return {
    entries,
    intern(name) {
      let index = indexes.get(name);
      if (index === undefined) {
        index = entries.length;
        indexes.set(name, index);
        entries.push({ stringIndex: stringPool.intern(encoder.encode(name)) });
      }
      return index;
    },
  };
}

function emitStringLiteralDeclarations(pool) {
  if (pool.entries.length === 0) return "";
  const globals = pool.entries.map((bytes, index) => {
    const elements = [...bytes].map((byte) => `(i32.const ${byte})`).join(" ");
    const initializer = `(array.new_fixed ${STRING_LITERAL_TYPE} ${bytes.length}${
      elements.length === 0 ? "" : ` ${elements}`
    })`;
    return `(global ${STRING_LITERAL_GLOBAL_PREFIX}${index} (ref ${STRING_LITERAL_TYPE}) ${initializer})`;
  });
  return `(type ${STRING_LITERAL_TYPE} (array (mut i8)))\n${globals.join("\n")}`;
}

function emitSymbolLiteralDeclarations(pool, userStart) {
  const globals = pool.entries.map((entry, index) =>
    `(global ${SYMBOL_LITERAL_GLOBAL_PREFIX}${index} (mut (ref eq)) (ref.i31 (i32.const 0)))`);
  const assignments = pool.entries.map((entry, index) =>
    `  (global.set ${SYMBOL_LITERAL_GLOBAL_PREFIX}${index} `
      + `(call ${SYMBOL_INTERN_FUNCTION} (global.get ${STRING_LITERAL_GLOBAL_PREFIX}${entry.stringIndex})))`);
  const initializer = `(func ${SYMBOL_INITIALIZER_FUNCTION}\n${assignments.join("\n")})`;
  const start = userStart === undefined
    ? `(start ${SYMBOL_INITIALIZER_FUNCTION})`
    : `(func ${GENERATED_START_FUNCTION}\n`
      + `  (call ${SYMBOL_INITIALIZER_FUNCTION})\n`
      + `  (call ${userStart}))\n`
      + `(start ${GENERATED_START_FUNCTION})`;
  return `${globals.join("\n")}\n${initializer}\n${start}`;
}

function operandUsesShorthand(idle, values, head, index) {
  if (index === 0) return false;
  if (head?.startsWith("@")) return false;
  const policy = WAT_OPERAND_POLICIES.get(head) ?? OPERANDS_ALL;
  if (policy.mode === "none") return false;
  if (policy.mode === "all") return true;
  if (policy.mode === "last") return index === values.length - 1;
  if (policy.mode === "after") return index > policy.count;
  if (policy.mode === "afterOptionalName") {
    const first = values.length > 1 ? plainSymbolName(idle, values[1]) : undefined;
    return index > (first?.startsWith("$") ? 1 : 0);
  }
  throw new Error(`unknown WAT operand policy: ${policy.mode}`);
}

function operandIsValueType(idle, values, head, index) {
  if (index === 0) return false;
  if (head === "result") return true;
  if (head === "mut" || head === "array") return index === 1;
  if (head === "ref.cast" || head === "ref.test") return index === 1;
  if (head === "br_on_cast" || head === "br_on_cast_fail") {
    return index === 2 || index === 3;
  }
  if (head === "param" || head === "local" || head === "field") {
    const first = values.length > 1 ? plainSymbolName(idle, values[1]) : undefined;
    const hasName = values.length > 2 && first?.startsWith("$");
    return index > (hasName ? 1 : 0);
  }
  if (head === "global") {
    const first = values.length > 1 ? plainSymbolName(idle, values[1]) : undefined;
    const hasName = values.length > 3 && first?.startsWith("$");
    return index === (hasName ? 2 : 1);
  }
  return false;
}

function emitValueType(idle, value, options) {
  return emitExpandedWat(idle, value, {
    ...options,
    enableShorthand: false,
    valueTypeRoot: true,
  }).trimEnd();
}

function emitFunctionFields(idle, name, prefixDeclarations, fields, options) {
  const pieces = ["(func"];
  if (name !== undefined) pieces.push(` ${name}`);
  const declarations = fields.filter((value) =>
    FUNCTION_DECLARATION_HEADS.has(plainHeadName(idle, value)));
  const body = fields.filter((value) =>
    !FUNCTION_DECLARATION_HEADS.has(plainHeadName(idle, value)));
  for (const declaration of prefixDeclarations) pieces.push(` ${declaration}`);
  for (const declaration of declarations) {
    pieces.push(` ${emitExpandedWat(idle, declaration, {
      ...options,
      enableShorthand: true,
    }).trimEnd()}`);
  }

  const lets = body.filter((value) => plainHeadName(idle, value) === "let");
  for (const letForm of lets) {
    const letValues = listValues(idle, letForm);
    const localName = letValues.length === 4 ? plainSymbolName(idle, letValues[1]) : undefined;
    if (localName === undefined || !localName.startsWith("$")) {
      throw compilerError(
        "INVALID_LET",
        "let requires a $local name, one value type, and one initializer",
      );
    }
    const type = emitValueType(idle, letValues[2], options);
    pieces.push(` (local ${localName} ${type})`);
  }

  for (const value of body) {
    if (plainHeadName(idle, value) === "let") {
      const letValues = listValues(idle, value);
      const localName = plainSymbolName(idle, letValues[1]);
      const initializer = emitExpandedWat(idle, letValues[3], {
        ...options,
        enableShorthand: true,
      }).trimEnd();
      pieces.push(` (local.set ${localName} ${initializer})`);
    } else {
      pieces.push(` ${emitExpandedWat(idle, value, {
        ...options,
        enableShorthand: true,
      }).trimEnd()}`);
    }
  }
  pieces.push(")");
  return pieces.join("");
}

function emitFunctionWithLets(idle, values, options) {
  let index = 1;
  const possibleName = values.length > 1 ? plainSymbolName(idle, values[1]) : undefined;
  const name = possibleName?.startsWith("$") ? possibleName : undefined;
  if (name !== undefined) index += 1;
  return emitFunctionFields(idle, name, [], values.slice(index), options);
}

function emitDefun(idle, values, options) {
  const name = values.length > 1 ? plainSymbolName(idle, values[1]) : undefined;
  if (name === undefined || !name.startsWith("$") || values.length < 3) {
    throw compilerError("INVALID_DEFUN", "defun requires a $function name and a signature list");
  }
  if (idle.kind(values[2]) !== "nil" && idle.kind(values[2]) !== "cons") {
    throw compilerError("INVALID_DEFUN", "defun signature must be a proper list");
  }
  const signature = listValues(idle, values[2]);
  const parameters = [];
  let result;
  for (const item of signature) {
    const parts = idle.kind(item) === "cons" ? listValues(idle, item) : [];
    const parameterName = parts.length === 2 ? plainSymbolName(idle, parts[0]) : undefined;
    if (parameterName?.startsWith("$") && result === undefined) {
      const type = emitValueType(idle, parts[1], options);
      parameters.push(`(param ${parameterName} ${type})`);
      continue;
    }
    if (result !== undefined) {
      throw compilerError("INVALID_DEFUN", "defun signature may contain only one result type");
    }
    result = emitValueType(idle, item, options);
  }
  const fields = values.slice(3);
  const exports = fields
    .filter((value) => plainHeadName(idle, value) === "export")
    .map((value) => emitExpandedWat(idle, value, {
      ...options,
      enableShorthand: true,
    }).trimEnd());
  const declarations = [...exports, ...parameters];
  if (result !== undefined) declarations.push(`(result ${result})`);
  return emitFunctionFields(
    idle,
    name,
    declarations,
    fields.filter((value) => plainHeadName(idle, value) !== "export"),
    options,
  );
}

function emitIfWithElif(idle, values, options) {
  const firstBranch = values.findIndex((value, index) =>
    index > 0 && ["then", "elif", "else"].includes(plainHeadName(idle, value)));
  if (firstBranch < 2 || plainHeadName(idle, values[firstBranch]) !== "then") {
    throw compilerError("INVALID_ELIF", "if with elif requires a condition followed by then");
  }
  const header = values.slice(1, firstBranch);
  if (plainSymbolName(idle, header[0])?.startsWith("$")) {
    throw compilerError("INVALID_ELIF", "elif does not support a named WAT if");
  }
  const prefix = header.slice(0, -1).map((value) => emitExpandedWat(idle, value, {
    ...options,
    enableShorthand: true,
  }).trimEnd());
  const conditions = [header.at(-1)];
  const bodies = [listValues(idle, values[firstBranch]).slice(1)];
  let elseBody;
  let sawElse = false;
  for (const branch of values.slice(firstBranch + 1)) {
    const branchValues = listValues(idle, branch);
    const branchName = plainSymbolName(idle, branchValues[0]);
    if (branchName === "elif" && !sawElse && branchValues.length >= 2) {
      conditions.push(branchValues[1]);
      bodies.push(branchValues.slice(2));
    } else if (branchName === "else" && !sawElse) {
      sawElse = true;
      elseBody = branchValues.slice(1);
    } else {
      throw compilerError("INVALID_ELIF", "elif branches must precede at most one final else");
    }
  }
  const emit = (value) => emitExpandedWat(idle, value, {
    ...options,
    enableShorthand: true,
  }).trimEnd();
  const emitBody = (body) => body.map(emit).join(" ");
  function build(index) {
    const pieces = ["(if", ...prefix, emit(conditions[index]), `(then${
      bodies[index].length === 0 ? "" : ` ${emitBody(bodies[index])}`
    })`];
    if (index + 1 < conditions.length) {
      pieces.push(`(else ${build(index + 1)})`);
    } else if (elseBody !== undefined) {
      pieces.push(`(else${elseBody.length === 0 ? "" : ` ${emitBody(elseBody)}`})`);
    }
    return `${pieces.join(" ")})`;
  }
  return build(0);
}

function emitExpandedWat(idle, root, {
  allowQualified = false,
  enableShorthand = false,
  stringPool,
  symbolPool,
  literalUsage,
  skippedForms = new Set(),
  preserveIdleStrings = false,
  valueTypeRoot = false,
} = {}) {
  const output = [];
  const tasks = [{
    type: "value",
    value: root,
    shorthand: enableShorthand,
    valueType: valueTypeRoot,
  }];
  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task.type === "text") {
      output.push(task.text);
      continue;
    }
    if (skippedForms.has(task.value)) continue;
    const kind = idle.kind(task.value);
    if (kind === "symbol") {
      const moduleName = idle.symbolModuleName(task.value);
      if (moduleName !== null) {
        if (!allowQualified) {
          throw compilerError(
            "UNEXPANDED_QUALIFIED_SYMBOL",
            `unexpanded macro symbol ${moduleName}:${idle.symbolName(task.value)}`,
          );
        }
        output.push(`${moduleName}:${idle.symbolName(task.value)}`);
      } else {
        const name = idle.symbolName(task.value);
        if (task.valueType && name.startsWith("$")) {
          output.push(`(ref ${name})`);
        } else {
          output.push(task.shorthand && name.startsWith("$")
            ? `(local.get ${name})`
            : name);
        }
      }
    } else if (kind === "integer") {
      output.push(String(idle.integerValue(task.value)));
    } else if (kind === "string") {
      const bytes = idle.stringBytes(task.value);
      if (stringPool !== undefined && task.shorthand) {
        output.push(`(global.get ${STRING_LITERAL_GLOBAL_PREFIX}${stringPool.intern(bytes)})`);
      } else {
        output.push(preserveIdleStrings ? escapeIdleString(bytes) : escapeWatBytes(bytes));
      }
    } else if (kind === "nil") {
      if (task.shorthand) {
        if (literalUsage === undefined) {
          throw compilerError("INTERNAL_LITERAL_USAGE", "literal usage state is unavailable");
        }
        literalUsage.nil = true;
        output.push(`(call ${NIL_FUNCTION})`);
      } else {
        output.push("()");
      }
    } else if (kind === "cons") {
      const values = listValues(idle, task.value);
      const head = values.length === 0 ? undefined : plainSymbolName(idle, values[0]);
      if (task.shorthand && head === "call-next-method") {
        throw compilerError(
          "CALL_NEXT_METHOD_OUTSIDE_METHOD",
          "call-next-method is only valid in a defmethod body",
        );
      }
      if (task.shorthand && head === "if"
          && values.some((value) => plainHeadName(idle, value) === "elif")) {
        output.push(emitIfWithElif(idle, values, {
          allowQualified,
          preserveIdleStrings,
          literalUsage,
          skippedForms,
          stringPool,
          symbolPool,
        }));
        continue;
      }
      if (task.shorthand && head === "defun") {
        output.push(emitDefun(idle, values, {
          allowQualified,
          preserveIdleStrings,
          literalUsage,
          skippedForms,
          stringPool,
          symbolPool,
        }));
        continue;
      }
      if (task.shorthand && head === "func"
          && values.slice(1).some((value) => plainHeadName(idle, value) === "let")) {
        output.push(emitFunctionWithLets(idle, values, {
          allowQualified,
          preserveIdleStrings,
          literalUsage,
          skippedForms,
          stringPool,
          symbolPool,
        }));
        continue;
      }
      if (task.shorthand && head === "let") {
        throw compilerError("LET_OUTSIDE_FUNCTION", "let must be a direct function-body form");
      }
      if (task.shorthand && head === "set") {
        const localName = values.length === 3 ? plainSymbolName(idle, values[1]) : undefined;
        if (localName === undefined || !localName.startsWith("$")) {
          throw compilerError("INVALID_SET", "set requires one $local name and one value");
        }
        const value = emitExpandedWat(idle, values[2], {
          allowQualified,
          enableShorthand: true,
          literalUsage,
          preserveIdleStrings,
          skippedForms,
          stringPool,
          symbolPool,
        }).trimEnd();
        output.push(`(local.set ${localName} ${value})`);
        continue;
      }
      if (task.shorthand && head === "quote") {
        if (values.length === 2 && idle.kind(values[1]) === "nil") {
          if (literalUsage === undefined) {
            throw compilerError("INTERNAL_LITERAL_USAGE", "literal usage state is unavailable");
          }
          literalUsage.nil = true;
          output.push(`(call ${NIL_FUNCTION})`);
          continue;
        }
        if (values.length !== 2 || idle.kind(values[1]) !== "symbol") {
          throw compilerError(
            "UNSUPPORTED_QUOTE_LITERAL",
            "compiled quote currently supports exactly one symbol or nil",
          );
        }
        if (idle.symbolModuleName(values[1]) !== null) {
          throw compilerError(
            "QUALIFIED_SYMBOL_LITERAL_UNSUPPORTED",
            "compiled quoted symbols must be unqualified",
          );
        }
        if (symbolPool === undefined) {
          throw compilerError("INTERNAL_SYMBOL_POOL", "symbol literal pool is unavailable");
        }
        const index = symbolPool.intern(idle.symbolName(values[1]));
        output.push(`(global.get ${SYMBOL_LITERAL_GLOBAL_PREFIX}${index})`);
        continue;
      }
      const directCall = task.shorthand && head?.startsWith("$");
      output.push(directCall ? "(call " : "(");
      tasks.push({ type: "text", text: ")" });
      for (let index = values.length - 1; index >= 0; index -= 1) {
        tasks.push({
          type: "value",
          value: values[index],
          shorthand: task.shorthand && (directCall
            ? index > 0
            : operandUsesShorthand(idle, values, head, index)),
          valueType: operandIsValueType(idle, values, head, index),
        });
        if (index > 0) tasks.push({ type: "text", text: " " });
      }
    } else {
      throw compilerError("UNSUPPORTED_WAT_VALUE", `cannot emit Idle ${kind} as WAT`);
    }
  }
  return `${output.join("")}\n`;
}

function analyzeStartForms(idle, root) {
  const values = listValues(idle, root);
  if (plainSymbolName(idle, values[0]) !== "module") {
    throw compilerError("INTERNAL_MODULE_FORM", "expanded compiler output is not a module");
  }
  const skippedForms = new Set();
  let userStart;
  let hasRawStart = false;
  for (const field of values.slice(1)) {
    const head = plainHeadName(idle, field);
    if (head === "start") hasRawStart = true;
    if (head !== "user-start") continue;
    const fieldValues = listValues(idle, field);
    const target = fieldValues.length === 2 ? plainSymbolName(idle, fieldValues[1]) : undefined;
    if (target === undefined || !target.startsWith("$")) {
      throw compilerError(
        "INVALID_USER_START",
        "user-start requires exactly one unqualified $function identifier",
      );
    }
    if (userStart !== undefined) {
      throw compilerError("DUPLICATE_USER_START", "only one user-start is allowed");
    }
    userStart = target;
    skippedForms.add(field);
  }
  if (userStart !== undefined && hasRawStart) {
    throw compilerError("DUPLICATE_START", "user-start cannot be combined with a raw start field");
  }
  return { hasRawStart, skippedForms, userStart };
}

function emitModuleFields(idle, root, options) {
  const values = listValues(idle, root);
  if (plainSymbolName(idle, values[0]) !== "module") {
    throw compilerError("EXPECTED_MODULE", "included Idle runtime must contain one explicit module");
  }
  return values.slice(1)
    .map((field) => emitExpandedWat(idle, field, options).trimEnd())
    .join("\n");
}

function macroEntries(macroModules) {
  return macroModules instanceof Map ? [...macroModules.entries()] : Object.entries(macroModules);
}

function attachSource(error, sources) {
  if (Number.isInteger(error?.sourceIndex) && sources[error.sourceIndex] !== undefined) {
    error.sourceName = sources[error.sourceIndex].name;
  }
  return error;
}

function plainHeadName(idle, value) {
  if (idle.kind(value) !== "cons") return undefined;
  const head = idle.car(value);
  if (idle.kind(head) !== "symbol" || idle.symbolModuleName(head) !== null) return undefined;
  return idle.symbolName(head);
}

function qualifiedModuleNames(idle, roots) {
  const result = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    const kind = idle.kind(value);
    if (kind === "symbol") {
      const moduleName = idle.symbolModuleName(value);
      if (moduleName !== null) result.add(moduleName);
    } else if (kind === "cons") {
      pending.push(idle.car(value), idle.cdr(value));
    }
  }
  return result;
}

export async function compileToWat({
  sources,
  macroModules = {},
  wasmPath = new URL("../build/objects.wasm", import.meta.url),
  includeBuiltInMacros = true,
  excludedBuiltInMacros = [],
} = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw compilerError("NO_INPUTS", "compileToWat requires at least one source");
  }
  let normalized = sources.map((source, index) => {
    if (source === null || typeof source !== "object" || typeof source.text !== "string") {
      throw compilerError("INVALID_SOURCE", `source ${index} must contain text`);
    }
    return { name: String(source.name ?? `<source-${index}>`), text: source.text };
  });

  const syntaxReader = await createReader({ wasmPath });
  normalized = normalized.map((source) => {
    let forms;
    try {
      forms = listValues(syntaxReader, syntaxReader.readAll(source.text));
    } catch (error) {
      error.sourceName = source.name;
      throw error;
    }
    if (forms.length !== 1 || plainHeadName(syntaxReader, forms[0]) !== "module") {
      throw compilerError("EXPECTED_MODULE", `${source.name} must contain one explicit module`, {
        sourceName: source.name,
      });
    }
    const moduleValues = listValues(syntaxReader, forms[0]);
    if (moduleValues.length > 1
        && syntaxReader.kind(moduleValues[1]) === "symbol"
        && syntaxReader.symbolModuleName(moduleValues[1]) === null
        && syntaxReader.symbolName(moduleValues[1]).startsWith("$")) {
      throw compilerError("NAMED_MODULE_UNSUPPORTED", `${source.name} contains a named module`, {
        sourceName: source.name,
      });
    }
    return { ...source, fields: moduleValues.slice(1) };
  });

  const configuredMacros = new Map(macroEntries(macroModules));
  const excludedBuiltIns = new Set(excludedBuiltInMacros);
  const referencedMacroModules = qualifiedModuleNames(
    syntaxReader,
    normalized.flatMap((source) => source.fields),
  );
  const internalRuntimeSources = [];
  if (includeBuiltInMacros
      && !excludedBuiltIns.has("dynamic")
      && (referencedMacroModules.has("dynamic")
        || referencedMacroModules.has("condition"))) {
    const text = await readFile(dynamicRuntimePath, "utf8");
    const forms = listValues(syntaxReader, syntaxReader.readAll(text));
    if (forms.length !== 1 || plainHeadName(syntaxReader, forms[0]) !== "module") {
      throw compilerError("DYNAMIC_RUNTIME_INVALID", "dynamic runtime must contain one explicit module");
    }
    internalRuntimeSources.push({
      name: dynamicRuntimePath.href,
      text,
      fields: listValues(syntaxReader, forms[0]).slice(1),
    });
  }
  if (includeBuiltInMacros
      && !excludedBuiltIns.has("condition")
      && referencedMacroModules.has("condition")) {
    const text = await readFile(conditionRuntimePath, "utf8");
    const forms = listValues(syntaxReader, syntaxReader.readAll(text));
    if (forms.length !== 1 || plainHeadName(syntaxReader, forms[0]) !== "module") {
      throw compilerError("CONDITION_RUNTIME_INVALID", "condition runtime must contain one explicit module");
    }
    internalRuntimeSources.push({
      name: conditionRuntimePath.href,
      text,
      fields: listValues(syntaxReader, forms[0]).slice(1),
    });
  }
  normalized.unshift(...internalRuntimeSources);
  const usesClassDsl = normalized.some((source) => source.fields.some(
    (field) => CLASS_DSL_HEADS.has(plainHeadName(syntaxReader, field)),
  ));
  if (includeBuiltInMacros) {
    for (const moduleName of ["classes", "condition", "control", "dynamic", "list"]) {
      if (configuredMacros.has(moduleName)) {
        throw compilerError("RESERVED_MACRO_MODULE", `the ${moduleName} macro module is built in`);
      }
    }
    if (!excludedBuiltIns.has("classes")
        && (usesClassDsl || referencedMacroModules.has("classes"))) {
      configuredMacros.set("classes", classesPath);
    }
    if (!excludedBuiltIns.has("control") && referencedMacroModules.has("control")) {
      configuredMacros.set("control", controlPath);
    }
    if (!excludedBuiltIns.has("dynamic") && referencedMacroModules.has("dynamic")) {
      configuredMacros.set("dynamic", dynamicPath);
    }
    if (!excludedBuiltIns.has("list") && referencedMacroModules.has("list")) {
      configuredMacros.set("list", listPath);
    }
    if (!excludedBuiltIns.has("condition") && referencedMacroModules.has("condition")) {
      configuredMacros.set("condition", conditionPath);
    }
  }

  const idle = await createReader({
    wasmPath,
    macroModules: configuredMacros,
    macroHostFactory: createClassMacroHost,
  });
  const emittedSources = normalized.map((source) => source.fields
    .map((field) => emitExpandedWat(syntaxReader, field, {
      allowQualified: true,
      preserveIdleStrings: true,
    }).trimEnd())
    .join("\n"));
  const compilerSource = usesClassDsl
    ? `(classes:module\n${emittedSources.map(
      (text, index) => `(classes:source ${index}\n${text}\n)`,
    ).join("\n")}\n)`
    : `(module\n${emittedSources.join("\n")}\n)`;
  let expanded;
  try {
    const forms = listValues(idle, idle.readAll(compilerSource));
    if (forms.length !== 1) throw compilerError("INTERNAL_MODULE_FORM", "compiler wrapper produced multiple forms");
    expanded = idle.macroexpand(forms[0]);
  } catch (error) {
    throw attachSource(error, normalized);
  }

  const { hasRawStart, skippedForms, userStart } = analyzeStartForms(idle, expanded);
  const stringPool = createStringLiteralPool();
  const symbolPool = createSymbolLiteralPool(stringPool);
  const literalUsage = { nil: false };
  let rawWat = emitExpandedWat(idle, expanded, {
    enableShorthand: true,
    literalUsage,
    skippedForms,
    stringPool,
    symbolPool,
  });
  if (idle.usedMacroModules.has("dynamic") || idle.usedMacroModules.has("condition")) {
    if (/\(export\s+"dynamic-unbound"/.test(rawWat)) {
      const exportCount = rawWat.match(/\(export\s+"dynamic-unbound"/g)?.length ?? 0;
      if (exportCount > 1) {
        throw compilerError("RESERVED_DYNAMIC_EXPORT", "dynamic-unbound is reserved by the dynamic runtime");
      }
    }
  }
  if (literalUsage.nil) {
    if (/\(func\s+\$idle\.nil(?:\s|\))/.test(rawWat)) {
      throw compilerError(
        "RESERVED_NIL_LITERAL_IDENTIFIER",
        "generated nil literals use the reserved $idle.nil function identifier",
      );
    }
    rawWat = rawWat.replace(
      /^\(module/,
      `(module\n(import "idle" "nil" (func ${NIL_FUNCTION} (result (ref eq))))`,
    );
  }
  if (stringPool.entries.length > 0) {
    if (/\(type\s+\$idle\.string-data(?:\s|\))/.test(rawWat)
        || /\(global\s+\$idle\.string\.\d+(?:\s|\))/.test(rawWat)) {
      throw compilerError(
        "RESERVED_STRING_LITERAL_IDENTIFIER",
        "generated string literal identifiers use the reserved $idle.string namespace",
      );
    }
    const declarations = emitStringLiteralDeclarations(stringPool);
    const moduleEnd = rawWat.lastIndexOf(")");
    rawWat = `${rawWat.slice(0, moduleEnd)}\n${declarations}\n${rawWat.slice(moduleEnd)}`;
  }
  if (symbolPool.entries.length > 0) {
    if (hasRawStart) {
      throw compilerError(
        "RAW_START_WITH_SYMBOLS",
        "a module containing quoted symbols must use user-start instead of start",
      );
    }
    const reservedIdentifier = /\((?:func|global|type|table|memory|tag)\s+\$idle\.(?:intern|initialize-symbols|start|symbol\.\d+)(?:\s|\))/;
    if (reservedIdentifier.test(rawWat)) {
      throw compilerError(
        "RESERVED_SYMBOL_LITERAL_IDENTIFIER",
        "generated symbol literal identifiers use the reserved $idle symbol namespace",
      );
    }
    rawWat = rawWat.replace(
      /^\(module/,
      `(module\n(import "idle" "intern" `
        + `(func ${SYMBOL_INTERN_FUNCTION} (param (ref eq)) (result (ref eq))))`,
    );
    const declarations = emitSymbolLiteralDeclarations(symbolPool, userStart);
    const moduleEnd = rawWat.lastIndexOf(")");
    rawWat = `${rawWat.slice(0, moduleEnd)}\n${declarations}\n${rawWat.slice(moduleEnd)}`;
  } else if (userStart !== undefined) {
    const moduleEnd = rawWat.lastIndexOf(")");
    rawWat = `${rawWat.slice(0, moduleEnd)}\n(start ${userStart})\n${rawWat.slice(moduleEnd)}`;
  }
  const { default: binaryen } = await import("binaryen");
  let module;
  try {
    module = binaryen.parseText(rawWat);
    module.setFeatures(idleWasmFeatures(binaryen));
    if (!module.validate()) throw new Error("generated module did not validate");
    return rawWat;
  } catch (cause) {
    throw compilerError("GENERATED_WAT_INVALID", "generated WAT did not validate", {
      cause,
      wat: rawWat,
    });
  } finally {
    module?.dispose();
  }
}

export async function compileFilesToWat({ inputPaths, ...options } = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw compilerError("NO_INPUTS", "compileFilesToWat requires at least one input path");
  }
  const sources = await Promise.all(inputPaths.map(async (inputPath) => ({
    name: inputPath instanceof URL ? inputPath.href : String(inputPath),
    text: await readFile(inputPath, "utf8"),
  })));
  return compileToWat({ ...options, sources });
}
