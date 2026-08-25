const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function createClassMacroHost({ wasm, internPlain, symbolLocalName }) {
  const symbols = new Map();
  let state;

  function symbol(name) {
    let value = symbols.get(name);
    if (value === undefined) {
      value = internPlain(name);
      symbols.set(name, value);
    }
    return value;
  }

  function list(...values) {
    let result = wasm.abi_nil();
    for (let index = values.length - 1; index >= 0; index -= 1) {
      result = wasm.abi_cons(values[index], result);
    }
    return result;
  }

  function listValues(value, sourceIndex) {
    const result = [];
    let cursor = value;
    while (!wasm.abi_is_nil(cursor)) {
      if (!wasm.abi_is_cons(cursor)) {
        fail("EXPECTED_PROPER_LIST", "expected a proper list", sourceIndex);
      }
      result.push(wasm.abi_car(cursor));
      cursor = wasm.abi_cdr(cursor);
    }
    return result;
  }

  function stringValue(text) {
    const bytes = new TextEncoder().encode(text);
    const value = wasm.abi_string(bytes.length);
    bytes.forEach((byte, index) => wasm.abi_string_set_byte(value, index, byte));
    return value;
  }

  function integerValue(value, sourceIndex) {
    if (!wasm.abi_is_integer(value)) fail("EXPECTED_INTEGER", "expected an integer", sourceIndex);
    return wasm.abi_integer_value(value);
  }

  function localName(value, sourceIndex, role = "name") {
    if (!wasm.abi_is_symbol(value) || wasm.abi_symbol_has_module(value)) {
      fail("EXPECTED_PLAIN_SYMBOL", `${role} must be a plain symbol`, sourceIndex);
    }
    return symbolLocalName(value);
  }

  function identifier(value, sourceIndex, role) {
    const name = localName(value, sourceIndex, role);
    if (!IDENTIFIER.test(name)) {
      fail("INVALID_IDENTIFIER", `${role} has invalid identifier ${name}`, sourceIndex);
    }
    return name;
  }

  function functionIdentifier(value, sourceIndex, role = "function") {
    const name = localName(value, sourceIndex, role);
    if (!/^\$[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
      fail("INVALID_FUNCTION_IDENTIFIER", `${role} has invalid identifier ${name}`, sourceIndex);
    }
    return name;
  }

  function headName(value) {
    if (!wasm.abi_is_cons(value)) return undefined;
    const head = wasm.abi_car(value);
    if (!wasm.abi_is_symbol(head) || wasm.abi_symbol_has_module(head)) return undefined;
    return symbolLocalName(head);
  }

  function isQualified(value, moduleName, name) {
    if (!wasm.abi_is_symbol(value) || !wasm.abi_symbol_has_module(value)) return false;
    const module = wasm.abi_symbol_module(value);
    return !wasm.abi_symbol_has_module(module)
      && symbolLocalName(module) === moduleName
      && symbolLocalName(value) === name;
  }

  function fail(code, message, sourceIndex, details = {}) {
    const error = new Error(message);
    error.name = "IdleClassError";
    error.code = code;
    error.idleMacroError = true;
    if (sourceIndex !== undefined) error.sourceIndex = sourceIndex;
    Object.assign(error, details);
    throw error;
  }

  function requireLength(values, length, code, message, sourceIndex) {
    if (values.length !== length) fail(code, message, sourceIndex);
  }

  function parseField(values, sourceIndex, seen) {
    requireLength(values, 2, "INVALID_FIELD", "field requires a name and type", sourceIndex);
    const name = identifier(values[0], sourceIndex, "field");
    if (seen.has(name)) fail("DUPLICATE_FIELD", `duplicate field ${name}`, sourceIndex);
    seen.add(name);
    let storageType = values[1];
    let valueType = storageType;
    let mutable = false;
    if (headName(storageType) === "mut") {
      const parts = listValues(storageType);
      requireLength(parts, 2, "INVALID_FIELD_TYPE", `invalid mutable type for ${name}`, sourceIndex);
      mutable = true;
      valueType = parts[1];
    }
    return { name, storageType, valueType, mutable, sourceIndex };
  }

  function parseParameters(value, sourceIndex) {
    const seen = new Set();
    return listValues(value).map((parameter) => {
      const parts = listValues(parameter);
      requireLength(parts, 2, "INVALID_PARAMETER", "parameter requires a name and type", sourceIndex);
      const name = identifier(parts[0], sourceIndex, "parameter");
      if (seen.has(name)) fail("DUPLICATE_PARAMETER", `duplicate parameter ${name}`, sourceIndex);
      seen.add(name);
      return { name, type: parts[1] };
    });
  }

  function parseGenericSignature(value, sourceIndex, role) {
    const values = listValues(value);
    if (values.length < 2) {
      fail(
        "INVALID_GENERIC_SIGNATURE",
        `${role} requires at least one parameter and exactly one result`,
        sourceIndex,
      );
    }
    return {
      parameters: parseParameters(list(...values.slice(0, -1)), sourceIndex),
      result: values.at(-1),
    };
  }

  function parseGeneric(form, sourceIndex, generics, sourceOrder) {
    const values = listValues(form);
    requireLength(
      values,
      3,
      "INVALID_DEFGENERIC",
      "defgeneric requires a $function name and signature list",
      sourceIndex,
    );
    const name = functionIdentifier(values[1], sourceIndex, "generic function");
    if (generics.has(name)) fail("DUPLICATE_GENERIC", `duplicate generic ${name}`, sourceIndex);
    const signature = parseGenericSignature(values[2], sourceIndex, `generic ${name}`);
    const generic = { name, ...signature, sourceIndex, sourceOrder, methods: new Map() };
    generics.set(name, generic);
    return generic;
  }

  function parseGenericMethod(form, sourceIndex) {
    const values = listValues(form);
    if (values.length < 3) {
      fail(
        "INVALID_DEFMETHOD",
        "defmethod requires a $generic name, signature list, and optional body",
        sourceIndex,
      );
    }
    const name = functionIdentifier(values[1], sourceIndex, "generic method");
    return {
      name,
      ...parseGenericSignature(values[2], sourceIndex, `method ${name}`),
      body: values.slice(3),
      sourceIndex,
    };
  }

  function parseClass(form, sourceIndex, classes) {
    const values = listValues(form, sourceIndex);
    if (values.length < 2) fail("INVALID_DEFCLASS", "defclass requires a name", sourceIndex);
    const name = identifier(values[1], sourceIndex, "class");
    if (classes.has(name)) fail("DUPLICATE_CLASS", `duplicate class ${name}`, sourceIndex);
    const fields = [];
    const fieldNames = new Set();
    let parentName;
    if (values.length > 2) {
      const superclasses = listValues(values[2], sourceIndex);
      if (superclasses.length > 1) {
        fail("MULTIPLE_SUPERCLASSES", `class ${name} may have at most one superclass`, sourceIndex);
      }
      if (superclasses.length === 1) {
        parentName = identifier(superclasses[0], sourceIndex, "parent class");
      }
      for (const field of values.slice(3)) {
        fields.push(parseField(listValues(field, sourceIndex), sourceIndex, fieldNames));
      }
    }
    const result = {
      name,
      parentName,
      fields,
      sourceIndex,
      status: "new",
    };
    classes.set(name, result);
    return result;
  }

  function resolveClass(classInfo, classes, ordered) {
    if (classInfo.status === "done") return;
    if (classInfo.status === "visiting") {
      fail("INHERITANCE_CYCLE", `inheritance cycle at ${classInfo.name}`, classInfo.sourceIndex);
    }
    classInfo.status = "visiting";
    let parent;
    if (classInfo.parentName !== undefined) {
      parent = classes.get(classInfo.parentName);
      if (parent === undefined) {
        fail("UNKNOWN_PARENT", `unknown parent ${classInfo.parentName}`, classInfo.sourceIndex);
      }
      resolveClass(parent, classes, ordered);
    }
    classInfo.parent = parent;
    classInfo.layout = parent === undefined ? [] : [...parent.layout];
    const inheritedFields = new Set(classInfo.layout.map((field) => field.name));
    for (const field of classInfo.fields) {
      if (inheritedFields.has(field.name)) {
        fail("FIELD_SHADOWING", `field ${field.name} shadows an inherited field`, field.sourceIndex);
      }
      classInfo.layout.push(field);
      inheritedFields.add(field.name);
    }

    classInfo.status = "done";
    ordered.push(classInfo);
  }

  function id(name) {
    return symbol(`$${name}`);
  }

  function ref(typeName) {
    return list(symbol("ref"), id(typeName));
  }

  function nullableRef(typeName) {
    return list(symbol("ref"), symbol("null"), id(typeName));
  }

  function checkedTypeFromDatum(value, classes, sourceIndex, role, required = false) {
    if (wasm.abi_is_symbol(value) && !wasm.abi_symbol_has_module(value)) {
      const name = symbolLocalName(value);
      if (name === "i32") return { kind: "i32", wat: symbol("i32") };
      const classInfo = classes.get(name);
      if (classInfo !== undefined) return { kind: "class", classInfo, wat: ref(name) };
    } else if (headName(value) === "ref") {
      const parts = listValues(value);
      if (parts.length === 2 && wasm.abi_is_symbol(parts[1])
          && !wasm.abi_symbol_has_module(parts[1])) {
        const typeName = symbolLocalName(parts[1]);
        if (typeName.startsWith("$")) {
          const classInfo = classes.get(typeName.slice(1));
          if (classInfo !== undefined) return { kind: "class", classInfo, wat: ref(classInfo.name) };
        }
      }
    }
    if (required) fail("UNKNOWN_CHECKED_TYPE", `${role} must be i32 or a declared class`, sourceIndex);
    return undefined;
  }

  function formatCheckedType(type) {
    return type.kind === "i32" ? "i32" : type.classInfo.name;
  }

  function isAssignable(actual, expected) {
    if (actual.kind !== expected.kind) return false;
    if (actual.kind === "i32") return true;
    let cursor = actual.classInfo;
    while (cursor !== undefined) {
      if (cursor === expected.classInfo) return true;
      cursor = cursor.parent;
    }
    return false;
  }

  function datumTypeKey(value) {
    if (wasm.abi_is_symbol(value) && !wasm.abi_symbol_has_module(value)) {
      return symbolLocalName(value);
    }
    if (wasm.abi_is_integer(value)) return String(wasm.abi_integer_value(value));
    if (wasm.abi_is_cons(value) || wasm.abi_is_nil(value)) {
      return `(${listValues(value).map(datumTypeKey).join(" ")})`;
    }
    return "<?>";
  }

  function normalizeDeclarationType(value, classes, sourceIndex, role) {
    const checked = checkedTypeFromDatum(value, classes, sourceIndex, role);
    return { checked, wat: checked?.wat ?? value };
  }

  function normalizeClassDeclarations(ordered, classes) {
    for (const classInfo of ordered) {
      for (const field of classInfo.fields) {
        const type = normalizeDeclarationType(
          field.valueType,
          classes,
          field.sourceIndex,
          `field ${classInfo.name}.${field.name}`,
        );
        field.checkedType = type.checked;
        field.valueType = type.wat;
        field.storageType = field.mutable
          ? list(symbol("mut"), type.wat)
          : type.wat;
      }
    }
  }

  function isSubclass(classInfo, ancestor) {
    let cursor = classInfo;
    while (cursor !== undefined) {
      if (cursor === ancestor) return true;
      cursor = cursor.parent;
    }
    return false;
  }

  function normalizeParameter(parameter, classes, sourceIndex, role, required = false) {
    const type = normalizeDeclarationType(parameter.type, classes, sourceIndex, role);
    if (required && type.checked?.kind !== "class") {
      fail("INVALID_DISPATCH_TYPE", `${role} must be a declared non-null class`, sourceIndex);
    }
    parameter.checkedType = type.checked;
    parameter.type = type.wat;
  }

  function resolveGenerics(generics, methodItems, ordered, classes) {
    const genericList = [...generics.values()];
    for (const generic of genericList) {
      generic.parameters.forEach((parameter, index) => normalizeParameter(
        parameter,
        classes,
        generic.sourceIndex,
        `parameter ${generic.name}.${parameter.name}`,
        index === 0,
      ));
      generic.dispatchClass = generic.parameters[0].checkedType.classInfo;
      const resultType = normalizeDeclarationType(
        generic.result,
        classes,
        generic.sourceIndex,
        `result of ${generic.name}`,
      );
      generic.checkedResult = resultType.checked;
      generic.result = resultType.wat;
    }

    const methods = methodItems.map((item) => parseGenericMethod(item.form, item.sourceIndex));
    for (const method of methods) {
      const generic = generics.get(method.name);
      if (generic === undefined) {
        fail("UNKNOWN_GENERIC", `unknown generic ${method.name}`, method.sourceIndex);
      }
      if (method.parameters.length !== generic.parameters.length) {
        fail(
          "METHOD_SIGNATURE_MISMATCH",
          `method ${method.name} must exactly match the generic arity`,
          method.sourceIndex,
        );
      }
      method.parameters.forEach((parameter, index) => normalizeParameter(
        parameter,
        classes,
        method.sourceIndex,
        `parameter ${method.name}.${parameter.name}`,
        index === 0,
      ));
      const resultType = normalizeDeclarationType(
        method.result,
        classes,
        method.sourceIndex,
        `result of ${method.name}`,
      );
      method.checkedResult = resultType.checked;
      method.result = resultType.wat;
      method.generic = generic;
      method.specializer = method.parameters[0].checkedType.classInfo;
      if (!isSubclass(method.specializer, generic.dispatchClass)) {
        fail(
          "UNRELATED_METHOD_SPECIALIZER",
          `${method.specializer.name} does not extend ${generic.dispatchClass.name}`,
          method.sourceIndex,
        );
      }
      const parametersMatch = method.parameters.slice(1).every((parameter, index) => (
        datumTypeKey(parameter.type) === datumTypeKey(generic.parameters[index + 1].type)
      ));
      if (!parametersMatch || datumTypeKey(method.result) !== datumTypeKey(generic.result)) {
        fail(
          "METHOD_SIGNATURE_MISMATCH",
          `method ${method.name} must exactly match its generic signature`,
          method.sourceIndex,
        );
      }
      if (generic.methods.has(method.specializer.name)) {
        fail(
          "DUPLICATE_METHOD",
          `duplicate method ${method.name} for ${method.specializer.name}`,
          method.sourceIndex,
        );
      }
      generic.methods.set(method.specializer.name, method);
    }

    for (const classInfo of ordered) {
      classInfo.slots = classInfo.parent === undefined
        ? []
        : classInfo.parent.slots.map((slot) => ({ ...slot }));
      classInfo.implementations = [];
      for (const generic of genericList) {
        if (generic.dispatchClass === classInfo) {
          classInfo.slots.push({ generic, implementation: generic });
        }
      }
      for (const generic of genericList) {
        const method = generic.methods.get(classInfo.name);
        if (method === undefined) continue;
        const index = classInfo.slots.findIndex((slot) => slot.generic === generic);
        if (index < 0) fail("INTERNAL_GENERIC_SLOT", `missing slot for ${generic.name}`);
        classInfo.slots[index] = { generic, implementation: method };
        classInfo.implementations.push(method);
      }
    }

    for (const method of methods) {
      let cursor = method.specializer.parent;
      while (cursor !== undefined && method.generic.methods.get(cursor.name) === undefined) {
        cursor = cursor.parent;
      }
      method.next = cursor === undefined ? method.generic : method.generic.methods.get(cursor.name);
      method.loweredBody = method.body.map((value) => lowerNextMethod(value, method));
    }
    return { genericList, methods };
  }

  function lowerNextMethod(value, method) {
    if (!wasm.abi_is_cons(value)) return value;
    const values = listValues(value);
    if (headName(value) === "quote") return value;
    if (headName(value) === "call-next-method") {
      if (values.length !== method.generic.parameters.length + 1) {
        fail(
          "CALL_NEXT_METHOD_ARITY",
          `call-next-method for ${method.name} requires ${method.generic.parameters.length} arguments`,
          method.sourceIndex,
        );
      }
      return list(symbol("call"), implementationId(method.next), ...values.slice(1));
    }
    return list(...values.map((item) => lowerNextMethod(item, method)));
  }

  function parseTypedFunction(item, classes) {
    const values = listValues(item.form);
    if (values.length < 4) {
      fail("INVALID_TYPED_DEFUN", "typed-defun requires a name, signature, and body", item.sourceIndex);
    }
    const name = functionIdentifier(values[1], item.sourceIndex, "typed function");
    const signature = listValues(values[2]);
    if (signature.length < 1) {
      fail("INVALID_TYPED_SIGNATURE", `${name} requires exactly one result type`, item.sourceIndex);
    }
    const parameters = [];
    const seen = new Set();
    for (const parameterValue of signature.slice(0, -1)) {
      const parts = listValues(parameterValue);
      requireLength(
        parts,
        2,
        "INVALID_TYPED_PARAMETER",
        `${name} parameters require a name and type`,
        item.sourceIndex,
      );
      const parameterName = functionIdentifier(parts[0], item.sourceIndex, "parameter");
      if (parameterName === "$this" || parameterName === "$self") {
        fail("RESERVED_PARAMETER", `parameter ${parameterName} is reserved`, item.sourceIndex);
      }
      if (seen.has(parameterName)) {
        fail("DUPLICATE_PARAMETER", `duplicate parameter ${parameterName}`, item.sourceIndex);
      }
      seen.add(parameterName);
      parameters.push({
        name: parameterName,
        type: checkedTypeFromDatum(
          parts[1],
          classes,
          item.sourceIndex,
          `parameter ${parameterName}`,
          true,
        ),
      });
    }
    const resultType = checkedTypeFromDatum(
      signature.at(-1),
      classes,
      item.sourceIndex,
      `result of ${name}`,
      true,
    );
    return {
      name,
      nameValue: values[1],
      parameters,
      resultType,
      body: values.slice(3),
      sourceIndex: item.sourceIndex,
    };
  }

  function rawFunctionSignature(item, classes) {
    if (headName(item.form) !== "defun") return undefined;
    const values = listValues(item.form);
    if (values.length < 3) return undefined;
    let name;
    let signature;
    try {
      name = functionIdentifier(values[1], item.sourceIndex);
      signature = listValues(values[2]);
    } catch {
      return undefined;
    }
    if (signature.length < 1) return undefined;
    const parameters = [];
    for (const parameterValue of signature.slice(0, -1)) {
      let parts;
      try {
        parts = listValues(parameterValue);
      } catch {
        return undefined;
      }
      if (parts.length !== 2) return undefined;
      const parameterName = localName(parts[0], item.sourceIndex, "parameter");
      const type = checkedTypeFromDatum(
        parts[1],
        classes,
        item.sourceIndex,
        `parameter ${parameterName}`,
      );
      if (type === undefined) return undefined;
      parameters.push({ name: parameterName, type });
    }
    const resultType = checkedTypeFromDatum(
      signature.at(-1),
      classes,
      item.sourceIndex,
      `result of ${name}`,
    );
    return resultType === undefined ? undefined : { name, parameters, resultType };
  }

  function requireAssignable(actual, expected, sourceIndex, context) {
    if (!isAssignable(actual, expected)) {
      fail(
        "TYPE_MISMATCH",
        `${context} requires ${formatCheckedType(expected)}, got ${formatCheckedType(actual)}`,
        sourceIndex,
      );
    }
  }

  function lowerTypedFunction(functionInfo, functions, classes) {
    const voidType = { kind: "void" };
    const environment = new Map(functionInfo.parameters.map((parameter) => [
      parameter.name,
      { kind: "parameter", type: parameter.type },
    ]));
    let loopIndex = 0;

    function checkArguments(arguments_, parameters, context) {
      if (arguments_.length !== parameters.length) {
        fail(
          "TYPED_CALL_ARITY",
          `${context} expects ${parameters.length} arguments, got ${arguments_.length}`,
          functionInfo.sourceIndex,
        );
      }
      return arguments_.map((argument, index) => {
        const checked = checkExpression(argument);
        requireAssignable(
          checked.type,
          parameters[index].type,
          functionInfo.sourceIndex,
          `argument ${index + 1} of ${context}`,
        );
        return checked.form;
      });
    }

    function checkExpression(value) {
      if (wasm.abi_is_integer(value)) {
        return { type: { kind: "i32" }, form: list(symbol("i32.const"), value) };
      }
      if (wasm.abi_is_symbol(value) && !wasm.abi_symbol_has_module(value)) {
        const name = symbolLocalName(value);
        if (!name.startsWith("$")) {
          fail("UNSUPPORTED_TYPED_EXPRESSION", `unsupported typed expression ${name}`, functionInfo.sourceIndex);
        }
        const binding = environment.get(name);
        if (binding === undefined) {
          fail("UNKNOWN_TYPED_LOCAL", `unknown local ${name}`, functionInfo.sourceIndex);
        }
        return { type: binding.type, form: value };
      }
      if (!wasm.abi_is_cons(value)) {
        fail("UNSUPPORTED_TYPED_EXPRESSION", "unsupported typed expression", functionInfo.sourceIndex);
      }
      const values = listValues(value);
      if (values.length === 0) {
        fail("UNSUPPORTED_TYPED_EXPRESSION", "empty typed expression", functionInfo.sourceIndex);
      }
      const name = localName(values[0], functionInfo.sourceIndex, "expression");
      if (name === "i32.add" || name === "i32.sub") {
        requireLength(values, 3, "TYPED_ARITY", `${name} expects two operands`, functionInfo.sourceIndex);
        const first = checkExpression(values[1]);
        const second = checkExpression(values[2]);
        const i32 = { kind: "i32" };
        requireAssignable(first.type, i32, functionInfo.sourceIndex, `${name} operand`);
        requireAssignable(second.type, i32, functionInfo.sourceIndex, `${name} operand`);
        return { type: i32, form: list(symbol(name), first.form, second.form) };
      }
      if (name === "i32.eqz") {
        requireLength(values, 2, "TYPED_ARITY", "i32.eqz expects one operand", functionInfo.sourceIndex);
        const operand = checkExpression(values[1]);
        const i32 = { kind: "i32" };
        requireAssignable(operand.type, i32, functionInfo.sourceIndex, "i32.eqz operand");
        return { type: i32, form: list(symbol("i32.eqz"), operand.form) };
      }
      if (/^\.[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        fail(
          "METHOD_SEND_SYNTAX_REMOVED",
          `${name} has been replaced by an ordinary $generic call with the receiver first`,
          functionInfo.sourceIndex,
        );
      }
      if (name.startsWith("$")) {
        const constructorMatch = /^\$([A-Za-z_][A-Za-z0-9_-]*)\.new$/.exec(name);
        if (constructorMatch !== null) {
          const classInfo = classes.get(constructorMatch[1]);
          if (classInfo === undefined) {
            fail("UNKNOWN_TYPED_CONSTRUCTOR", `unknown constructor ${name}`, functionInfo.sourceIndex);
          }
          if (classInfo.layout.some((field) => field.checkedType === undefined)) {
            fail("UNCHECKED_CONSTRUCTOR", `${name} does not have a checked signature`, functionInfo.sourceIndex);
          }
          const parameters = classInfo.layout.map((field) => ({
            name: field.name,
            type: field.checkedType,
          }));
          const arguments_ = checkArguments(values.slice(1), parameters, name);
          return {
            type: { kind: "class", classInfo },
            form: list(symbol("call"), symbol(name), ...arguments_),
          };
        }
        const target = functions.get(name);
        if (target === undefined) {
          fail("UNKNOWN_TYPED_FUNCTION", `unknown checked function ${name}`, functionInfo.sourceIndex);
        }
        const arguments_ = checkArguments(values.slice(1), target.parameters, name);
        return {
          type: target.resultType,
          form: list(symbol("call"), symbol(name), ...arguments_),
        };
      }
      fail("UNSUPPORTED_TYPED_EXPRESSION", `unsupported typed expression ${name}`, functionInfo.sourceIndex);
    }

    function checkSet(values) {
      requireLength(values, 3, "INVALID_TYPED_SET", "set requires a local and value", functionInfo.sourceIndex);
      const name = functionIdentifier(values[1], functionInfo.sourceIndex, "assigned local");
      const binding = environment.get(name);
      if (binding === undefined) fail("UNKNOWN_TYPED_LOCAL", `unknown local ${name}`, functionInfo.sourceIndex);
      if (binding.kind === "parameter") {
        fail("PARAMETER_ASSIGNMENT", `cannot assign parameter ${name}`, functionInfo.sourceIndex);
      }
      const value = checkExpression(values[2]);
      requireAssignable(value.type, binding.type, functionInfo.sourceIndex, `assignment to ${name}`);
      return { type: voidType, form: list(symbol("set"), symbol(name), value.form) };
    }

    function checkWhile(values) {
      if (values.length < 2) fail("INVALID_TYPED_WHILE", "while requires a condition", functionInfo.sourceIndex);
      const condition = checkExpression(values[1]);
      requireAssignable(condition.type, { kind: "i32" }, functionInfo.sourceIndex, "while condition");
      const body = values.slice(2).map((bodyValue) => {
        if (headName(bodyValue) === "let") {
          fail("NESTED_TYPED_LOCAL", "typed locals must be declared directly in the function body", functionInfo.sourceIndex);
        }
        const checked = checkStatement(bodyValue, false);
        if (checked.type.kind !== "void") {
          fail("NON_VOID_WHILE_BODY", "while body expressions must be void", functionInfo.sourceIndex);
        }
        return checked.form;
      });
      const labelBase = `typed.${functionInfo.name.slice(1)}.${loopIndex}`;
      loopIndex += 1;
      const done = id(`${labelBase}.done`);
      const again = id(`${labelBase}.again`);
      return {
        type: voidType,
        form: list(
          symbol("block"),
          done,
          list(
            symbol("loop"),
            again,
            list(symbol("br_if"), done, list(symbol("i32.eqz"), condition.form)),
            ...body,
            list(symbol("br"), again),
          ),
        ),
      };
    }

    function checkStatement(value, topLevel) {
      const name = headName(value);
      if (name === "set") return checkSet(listValues(value));
      if (name === "while") return checkWhile(listValues(value));
      if (name === "let") {
        if (!topLevel) {
          fail("NESTED_TYPED_LOCAL", "typed locals must be declared directly in the function body", functionInfo.sourceIndex);
        }
        const values = listValues(value);
        requireLength(values, 4, "INVALID_TYPED_LET", "let requires a local, type, and initializer", functionInfo.sourceIndex);
        const name = functionIdentifier(values[1], functionInfo.sourceIndex, "local");
        if (name === "$this" || name === "$self") {
          fail("RESERVED_LOCAL", `local ${name} is reserved`, functionInfo.sourceIndex);
        }
        if (environment.has(name)) fail("DUPLICATE_LOCAL", `duplicate local ${name}`, functionInfo.sourceIndex);
        const type = checkedTypeFromDatum(
          values[2],
          classes,
          functionInfo.sourceIndex,
          `local ${name}`,
          true,
        );
        const initializer = checkExpression(values[3]);
        requireAssignable(initializer.type, type, functionInfo.sourceIndex, `initializer for ${name}`);
        environment.set(name, { kind: "local", type });
        return {
          type: voidType,
          form: list(symbol("let"), symbol(name), type.wat, initializer.form),
        };
      }
      return checkExpression(value);
    }

    const body = functionInfo.body.map((value, index) => {
      const checked = checkStatement(value, true);
      const last = index === functionInfo.body.length - 1;
      if (!last && checked.type.kind !== "void") {
        fail("NON_VOID_TYPED_STATEMENT", "only the final typed function form may produce a value", functionInfo.sourceIndex);
      }
      if (last) {
        if (checked.type.kind === "void") {
          fail("MISSING_TYPED_RESULT", `${functionInfo.name} must end with a result`, functionInfo.sourceIndex);
        }
        requireAssignable(
          checked.type,
          functionInfo.resultType,
          functionInfo.sourceIndex,
          `result of ${functionInfo.name}`,
        );
      }
      return checked.form;
    });
    if (body.length === 0) {
      fail("MISSING_TYPED_RESULT", `${functionInfo.name} must have a body`, functionInfo.sourceIndex);
    }
    const signature = list(
      ...functionInfo.parameters.map((parameter) => (
        list(symbol(parameter.name), parameter.type.wat)
      )),
      functionInfo.resultType.wat,
    );
    return list(symbol("defun"), symbol(functionInfo.name), signature, ...body);
  }

  function param(name, type) {
    return list(symbol("param"), id(name), type);
  }

  function result(types) {
    return list(symbol("result"), ...types);
  }

  function resultForms(types) {
    return types.length === 0 ? [] : [result(types)];
  }

  function localGet(name) {
    return list(symbol("local.get"), id(name));
  }

  function genericStem(value) {
    const generic = value.generic ?? value;
    return generic.name.slice(1);
  }

  function signatureId(value) {
    return id(`generic.${genericStem(value)}.sig`);
  }

  function implementationId(value) {
    if (value.generic === undefined) return id(`generic.${genericStem(value)}.fallback`);
    return id(`generic.${genericStem(value)}.${value.specializer.name}.impl`);
  }

  function slotFieldId(generic) {
    return id(`generic.${genericStem(generic)}`);
  }

  function conditionMatcherId(classInfo) {
    return id(`condition.match.${classInfo.name}`);
  }

  function isConditionClass(classInfo) {
    let cursor = classInfo;
    while (cursor !== undefined) {
      if (cursor.name === "condition") return true;
      cursor = cursor.parent;
    }
    return false;
  }

  function emitConditionMatcherType() {
    return list(
      symbol("type"),
      id("condition.match.sig"),
      list(
        symbol("func"),
        param("value", ref("condition")),
        result([symbol("i32")]),
      ),
    );
  }

  function emitConditionMatcher(classInfo) {
    return list(
      symbol("func"),
      conditionMatcherId(classInfo),
      list(symbol("type"), id("condition.match.sig")),
      param("value", ref("condition")),
      result([symbol("i32")]),
      list(
        symbol("call"),
        id("condition.tag-is-a"),
        list(symbol("struct.get"), id("condition"), id("tag"), localGet("value")),
        list(symbol("global.get"), id(`${classInfo.name}.tag.value`)),
      ),
    );
  }

  function emitBaseTypes() {
    return [
      list(
        symbol("rec"),
        list(
          symbol("type"),
          id("tag"),
          list(
            symbol("sub"),
            list(
              symbol("struct"),
              list(symbol("field"), id("classes.parent-tag"), nullableRef("tag")),
            ),
          ),
        ),
        list(
          symbol("type"),
          id("obj"),
          list(
            symbol("sub"),
            list(symbol("struct"), list(symbol("field"), id("tag"), ref("tag"))),
          ),
        ),
      ),
    ];
  }

  function emitClassTypes(classInfo) {
    const types = [];
    for (const slot of classInfo.slots) {
      const generic = slot.generic;
      if (generic.dispatchClass !== classInfo) continue;
      types.push(list(
        symbol("type"),
        signatureId(generic),
        list(
          symbol("func"),
          ...generic.parameters.map((item) => param(item.name, item.type)),
          result([generic.result]),
        ),
      ));
    }
    const parentTag = classInfo.parent === undefined ? "tag" : `${classInfo.parent.name}.tag`;
    const tagFields = [
      list(symbol("field"), id("classes.parent-tag"), nullableRef("tag")),
      ...classInfo.slots.map((slot) => list(
        symbol("field"),
        slotFieldId(slot.generic),
        list(symbol("ref"), signatureId(slot.generic)),
      )),
    ];
    types.push(list(
      symbol("type"),
      id(`${classInfo.name}.tag`),
      list(symbol("sub"), id(parentTag), list(symbol("struct"), ...tagFields)),
    ));
    const parentType = classInfo.parent === undefined ? "obj" : classInfo.parent.name;
    const fields = [list(symbol("field"), id("tag"), ref(`${classInfo.name}.tag`))];
    fields.push(...classInfo.layout.map((field) => list(
      symbol("field"), id(field.name), field.storageType,
    )));
    types.push(list(
      symbol("type"),
      id(classInfo.name),
      list(symbol("sub"), id(parentType), list(symbol("struct"), ...fields)),
    ));
    return list(symbol("rec"), ...types);
  }

  function emitImplementation(method) {
    const generic = method.generic;
    const receiver = method.parameters[0];
    return list(
      symbol("func"),
      implementationId(method),
      list(symbol("type"), signatureId(generic)),
      param("generic.receiver", generic.parameters[0].type),
      ...method.parameters.slice(1).map((item) => param(item.name, item.type)),
      result([generic.result]),
      list(symbol("local"), id(receiver.name), receiver.type),
      list(
        symbol("local.set"),
        id(receiver.name),
        list(symbol("ref.cast"), receiver.type, localGet("generic.receiver")),
      ),
      ...method.loweredBody,
    );
  }

  function emitFallback(generic) {
    return list(
      symbol("func"),
      implementationId(generic),
      list(symbol("type"), signatureId(generic)),
      ...generic.parameters.map((item) => param(item.name, item.type)),
      result([generic.result]),
      list(symbol("unreachable")),
    );
  }

  function emitDescriptor(classInfo) {
    return list(
      symbol("global"),
      id(`${classInfo.name}.tag.value`),
      ref(`${classInfo.name}.tag`),
      list(
        symbol("struct.new"),
        id(`${classInfo.name}.tag`),
        classInfo.parent === undefined
          ? list(symbol("ref.null"), id("tag"))
          : list(symbol("global.get"), id(`${classInfo.parent.name}.tag.value`)),
        ...classInfo.slots.map((slot) => list(symbol("ref.func"), implementationId(slot.implementation))),
      ),
    );
  }

  function emitConstructor(classInfo) {
    return list(
      symbol("func"),
      id(`${classInfo.name}.new`),
      ...classInfo.layout.map((field) => param(field.name, field.valueType)),
      result([ref(classInfo.name)]),
      list(
        symbol("struct.new"),
        id(classInfo.name),
        list(symbol("global.get"), id(`${classInfo.name}.tag.value`)),
        ...classInfo.layout.map((field) => localGet(field.name)),
      ),
    );
  }

  function emitDispatcher(generic) {
    const owner = generic.dispatchClass;
    const receiver = generic.parameters[0];
    return list(
      symbol("func"),
      symbol(generic.name),
      ...generic.parameters.map((item) => param(item.name, item.type)),
      result([generic.result]),
      list(
        symbol("return_call_ref"),
        signatureId(generic),
        ...generic.parameters.map((item) => localGet(item.name)),
        list(
          symbol("struct.get"),
          id(`${owner.name}.tag`),
          slotFieldId(generic),
          list(symbol("struct.get"), id(owner.name), id("tag"), localGet(receiver.name)),
        ),
      ),
    );
  }

  function emitExport(externalName, functionName) {
    return list(
      symbol("export"),
      stringValue(externalName),
      list(symbol("func"), functionName),
    );
  }

  function moduleMacro(form) {
    const invocation = listValues(form);
    const sourceForms = [];
    for (const wrapper of invocation.slice(1)) {
      const wrapperValues = listValues(wrapper);
      if (!isQualified(wrapperValues[0], "classes", "source") || wrapperValues.length < 2) {
        fail("INVALID_SOURCE_WRAPPER", "compiler input is missing its source wrapper");
      }
      const sourceIndex = integerValue(wrapperValues[1]);
      for (const sourceForm of wrapperValues.slice(2)) sourceForms.push({ form: sourceForm, sourceIndex });
    }

    const classes = new Map();
    const generics = new Map();
    const methodItems = [];
    const rawFields = [];
    const typedFunctionItems = [];
    const exports = [];
    for (const [sourceOrder, item] of sourceForms.entries()) {
      const name = headName(item.form);
      if (name === "defclass") {
        parseClass(item.form, item.sourceIndex, classes);
      } else if (name === "class") {
        fail(
          "CLASS_SYNTAX_REMOVED",
          "class has been replaced by defclass with a superclass list and direct field declarations",
          item.sourceIndex,
        );
      } else if (name === "defgeneric") {
        parseGeneric(item.form, item.sourceIndex, generics, sourceOrder);
      } else if (name === "defmethod") {
        methodItems.push(item);
      } else if (name === "typed-defun") {
        typedFunctionItems.push(item);
      } else if (name === "export-new" || name === "export-method" || name === "export-func") {
        exports.push({ kind: name, values: listValues(item.form), sourceIndex: item.sourceIndex });
      } else {
        rawFields.push(item);
      }
    }

    const ordered = [];
    for (const classInfo of classes.values()) resolveClass(classInfo, classes, ordered);
    normalizeClassDeclarations(ordered, classes);
    const { genericList } = resolveGenerics(generics, methodItems, ordered, classes);
    const functions = new Map();
    const declaredFunctionNames = new Set();
    for (const generic of genericList) {
      declaredFunctionNames.add(generic.name);
      if (generic.parameters.every((parameter) => parameter.checkedType !== undefined)
          && generic.checkedResult !== undefined) {
        functions.set(generic.name, {
          name: generic.name,
          parameters: generic.parameters.map((parameter) => ({
            name: parameter.name,
            type: parameter.checkedType,
          })),
          resultType: generic.checkedResult,
        });
      }
    }
    for (const item of rawFields) {
      if (headName(item.form) !== "defun") continue;
      const values = listValues(item.form);
      if (values.length < 2) continue;
      const name = functionIdentifier(values[1], item.sourceIndex);
      if (declaredFunctionNames.has(name)) {
        fail("DUPLICATE_FUNCTION", `duplicate function ${name}`, item.sourceIndex);
      }
      declaredFunctionNames.add(name);
      const signature = rawFunctionSignature(item, classes);
      if (signature !== undefined) functions.set(name, signature);
    }
    const typedFunctions = typedFunctionItems.map((item) => parseTypedFunction(item, classes));
    for (const functionInfo of typedFunctions) {
      if (declaredFunctionNames.has(functionInfo.name)) {
        fail("DUPLICATE_FUNCTION", `duplicate function ${functionInfo.name}`, functionInfo.sourceIndex);
      }
      declaredFunctionNames.add(functionInfo.name);
      functions.set(functionInfo.name, functionInfo);
    }
    const loweredTypedFunctions = typedFunctions.map((functionInfo) => (
      lowerTypedFunction(functionInfo, functions, classes)
    ));
    const externalNames = new Set();
    const exportFields = [];
    for (const item of exports) {
      if (item.kind === "export-new") {
        requireLength(item.values, 2, "INVALID_EXPORT", "export-new requires a class", item.sourceIndex);
        const name = identifier(item.values[1], item.sourceIndex, "export class");
        if (!classes.has(name)) fail("UNKNOWN_EXPORT_CLASS", `unknown class ${name}`, item.sourceIndex);
        const external = `${name}.new`;
        if (externalNames.has(external)) fail("DUPLICATE_EXPORT", `duplicate export ${external}`, item.sourceIndex);
        externalNames.add(external);
        exportFields.push(emitExport(external, id(`${name}.new`)));
      } else if (item.kind === "export-method") {
        fail(
          "EXPORT_METHOD_SYNTAX_REMOVED",
          "export-method has been replaced by export-func for generic functions",
          item.sourceIndex,
        );
      } else {
        requireLength(item.values, 2, "INVALID_EXPORT", "export-func requires a function", item.sourceIndex);
        const name = identifier(item.values[1], item.sourceIndex, "export function");
        if (externalNames.has(name)) fail("DUPLICATE_EXPORT", `duplicate export ${name}`, item.sourceIndex);
        externalNames.add(name);
        exportFields.push(emitExport(name, id(name)));
      }
    }

    state = { classes };
    const isDynamicBindingDeclaration = (item) => {
      if (headName(item.form) !== "rec") return false;
      const recursiveTypes = listValues(item.form);
      if (recursiveTypes.length < 2 || headName(recursiveTypes[1]) !== "type") return false;
      const typeValues = listValues(recursiveTypes[1]);
      return typeValues.length > 1
        && wasm.abi_is_symbol(typeValues[1])
        && !wasm.abi_symbol_has_module(typeValues[1])
        && symbolLocalName(typeValues[1]) === "$dynamic.binding";
    };
    const importFields = rawFields
      .filter((item) => headName(item.form) === "import")
      .map((item) => item.form);
    const earlyTypeFields = rawFields
      .filter(isDynamicBindingDeclaration)
      .map((item) => item.form);
    const nonImportFields = rawFields
      .filter((item) => headName(item.form) !== "import" && !isDynamicBindingDeclaration(item))
      .map((item) => item.form);
    const moduleFields = [...importFields, ...earlyTypeFields, ...emitBaseTypes()];
    for (const classInfo of ordered) moduleFields.push(emitClassTypes(classInfo));
    const conditionClasses = ordered.filter(isConditionClass);
    if (conditionClasses.length > 0) {
      moduleFields.push(emitConditionMatcherType());
      for (const classInfo of conditionClasses) {
        moduleFields.push(emitConditionMatcher(classInfo));
      }
    }
    const implementationIds = [];
    for (const generic of genericList) {
      moduleFields.push(emitFallback(generic));
      implementationIds.push(implementationId(generic));
    }
    for (const classInfo of ordered) {
      for (const method of classInfo.implementations) {
        moduleFields.push(emitImplementation(method));
        implementationIds.push(implementationId(method));
      }
    }
    if (implementationIds.length > 0) {
      moduleFields.push(list(symbol("elem"), symbol("declare"), symbol("func"), ...implementationIds));
    }
    for (const classInfo of ordered) moduleFields.push(emitDescriptor(classInfo));
    for (const classInfo of ordered) moduleFields.push(emitConstructor(classInfo));
    for (const generic of genericList) moduleFields.push(emitDispatcher(generic));
    moduleFields.push(...nonImportFields, ...loweredTypedFunctions, ...exportFields);
    return list(symbol("module"), ...moduleFields);
  }

  function requireState(sourceIndex) {
    if (state === undefined) fail("CLASS_MODULE_NOT_EXPANDED", "classes:module must expand first", sourceIndex);
    return state;
  }

  function resolveHelper(form, expectedLength, operation) {
    const values = listValues(form);
    if (values.length < expectedLength) fail("INVALID_CLASS_OPERATION", `${operation} has too few operands`);
    const className = identifier(values[1], undefined, "class");
    const memberName = identifier(values[2], undefined, "field");
    const compilerState = requireState();
    const classInfo = compilerState.classes.get(className);
    if (classInfo === undefined) fail("UNKNOWN_CLASS", `unknown class ${className}`);
    return { values, classInfo, className, memberName };
  }

  function getMacro(form) {
    const { values, classInfo, memberName } = resolveHelper(form, 4, "get");
    requireLength(values, 4, "INVALID_GET", "classes:get requires class, field, and receiver", classInfo.sourceIndex);
    if (!classInfo.layout.some((field) => field.name === memberName)) {
      fail("UNKNOWN_FIELD", `unknown field ${classInfo.name}.${memberName}`, classInfo.sourceIndex);
    }
    return list(symbol("struct.get"), id(classInfo.name), id(memberName), values[3]);
  }

  function setMacro(form) {
    const { values, classInfo, memberName } = resolveHelper(form, 5, "set");
    requireLength(values, 5, "INVALID_SET", "classes:set requires class, field, receiver, and value", classInfo.sourceIndex);
    const field = classInfo.layout.find((candidate) => candidate.name === memberName);
    if (field === undefined) fail("UNKNOWN_FIELD", `unknown field ${classInfo.name}.${memberName}`, classInfo.sourceIndex);
    if (!field.mutable) fail("IMMUTABLE_FIELD", `field ${classInfo.name}.${memberName} is immutable`, classInfo.sourceIndex);
    return list(symbol("struct.set"), id(classInfo.name), id(memberName), values[3], values[4]);
  }

  function conditionMatcher(classValue) {
    const className = identifier(classValue, undefined, "condition handler class");
    const compilerState = requireState();
    const classInfo = compilerState.classes.get(className);
    if (classInfo === undefined) fail("UNKNOWN_CLASS", `unknown class ${className}`);
    if (!isConditionClass(classInfo)) {
      fail("NOT_CONDITION_CLASS", `${className} does not extend condition`, classInfo.sourceIndex);
    }
    return list(symbol("ref.func"), conditionMatcherId(classInfo));
  }

  function conditionFunction(functionValue) {
    const name = localName(functionValue, undefined, "condition callback");
    if (!/^\$[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
      fail("INVALID_CONDITION_CALLBACK", `condition callback has invalid identifier ${name}`);
    }
    return functionValue;
  }

  return {
    classes_module: moduleMacro,
    classes_get: getMacro,
    classes_set: setMacro,
    condition_function: conditionFunction,
    condition_matcher: conditionMatcher,
  };
}
