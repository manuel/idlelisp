const nil = null;

function cons(car, cdr) {
  return { car, cdr };
}

function list(...values) {
  let result = nil;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    result = cons(values[index], result);
  }
  return result;
}

function map(values, transform) {
  return values === nil ? nil : cons(transform(values.car), map(values.cdr, transform));
}

function length(values) {
  let result = 0;
  while (values !== nil) {
    result += 1;
    values = values.cdr;
  }
  return result;
}

function treeEqual(first, second) {
  if (first !== null && typeof first === "object") {
    return second !== null
      && typeof second === "object"
      && treeEqual(first.car, second.car)
      && treeEqual(first.cdr, second.cdr);
  }
  return Object.is(first, second);
}

const plus = Symbol("+");
const minus = Symbol("-");
const multiply = Symbol("*");
const divide = Symbol("/");
const xSymbol = Symbol("x");
const aSymbol = Symbol("a");
const bSymbol = Symbol("b");

function deriv(form) {
  if (form === null || typeof form !== "object") return form === xSymbol ? 1 : 0;
  const operator = form.car;
  const operands = form.cdr;
  if (operator === plus || operator === minus) {
    return cons(operator, map(operands, deriv));
  }
  if (operator === multiply) {
    return list(
      multiply,
      form,
      cons(plus, map(operands, (factor) => list(divide, deriv(factor), factor))),
    );
  }
  if (operator === divide) {
    const numerator = operands.car;
    const denominator = operands.cdr.car;
    return list(
      minus,
      list(divide, deriv(numerator), denominator),
      list(divide, numerator, list(multiply, denominator, denominator, deriv(denominator))),
    );
  }
  throw new Error("No derivation method available");
}

const derivInput = list(
  plus,
  list(multiply, 3, xSymbol, xSymbol),
  list(multiply, aSymbol, xSymbol, xSymbol),
  list(multiply, bSymbol, xSymbol),
  5,
);
const derivOutput = list(
  plus,
  list(multiply, list(multiply, 3, xSymbol, xSymbol),
    list(plus, list(divide, 0, 3), list(divide, 1, xSymbol), list(divide, 1, xSymbol))),
  list(multiply, list(multiply, aSymbol, xSymbol, xSymbol),
    list(plus, list(divide, 0, aSymbol), list(divide, 1, xSymbol), list(divide, 1, xSymbol))),
  list(multiply, list(multiply, bSymbol, xSymbol),
    list(plus, list(divide, 0, bSymbol), list(divide, 1, xSymbol))),
  0,
);

function createN(count) {
  let result = nil;
  while (count > 0) {
    result = cons(nil, result);
    count -= 1;
  }
  return result;
}

const dividend = createN(1000);
const l18 = createN(18);
const l12 = createN(12);
const l6 = createN(6);

function benchmarkDeriv() {
  return deriv(derivInput);
}

function benchmarkDiviter() {
  let values = dividend;
  let result = nil;
  while (values !== nil) {
    result = cons(values.car, result);
    values = values.cdr.cdr;
  }
  return result;
}

function divrec(values) {
  return values === nil ? nil : cons(values.car, divrec(values.cdr.cdr));
}

function benchmarkDivrec() {
  return divrec(dividend);
}

function tak(x, y, z) {
  return y < x
    ? tak(tak(x - 1, y, z), tak(y - 1, z, x), tak(z - 1, x, y))
    : z;
}

function benchmarkTak() {
  return tak(18, 12, 6);
}

function shorterp(first, second) {
  if (second === nil) return false;
  if (first === nil) return true;
  return shorterp(first.cdr, second.cdr);
}

function mas(first, second, third) {
  return shorterp(second, first)
    ? mas(mas(first.cdr, second, third), mas(second.cdr, third, first), mas(third.cdr, first, second))
    : third;
}

function benchmarkTakl() {
  return mas(l18, l12, l6);
}

function shorterpReadable(first, second) {
  if (second === nil) return false;
  if (first === nil) return true;
  return shorterpReadable(first.cdr, second.cdr);
}

function masReadable(first, second, third) {
  return shorterpReadable(second, first)
    ? masReadable(
      masReadable(first.cdr, second, third),
      masReadable(second.cdr, third, first),
      masReadable(third.cdr, first, second),
    )
    : third;
}

function benchmarkNtakl() {
  return masReadable(l18, l12, l6);
}

function cpstak(x, y, z) {
  function take(first, second, third, continuation) {
    if (second < first) {
      return take(first - 1, second, third, (firstResult) => (
        take(second - 1, third, first, (secondResult) => (
          take(third - 1, first, second, (thirdResult) => (
            take(firstResult, secondResult, thirdResult, continuation)
          ))
        ))
      ));
    }
    return continuation(third);
  }
  return take(x, y, z, (value) => value);
}

function benchmarkCpstak() {
  return cpstak(12, 6, 3);
}

export const benchmarks = new Map([
  ["deriv", benchmarkDeriv],
  ["diviter", benchmarkDiviter],
  ["divrec", benchmarkDivrec],
  ["tak", benchmarkTak],
  ["takl", benchmarkTakl],
  ["ntakl", benchmarkNtakl],
  ["cpstak", benchmarkCpstak],
]);

export function checkResults() {
  if (!treeEqual(benchmarkDeriv(), derivOutput)) throw new Error("JavaScript deriv failed");
  if (length(benchmarkDiviter()) !== 500) throw new Error("JavaScript diviter failed");
  if (length(benchmarkDivrec()) !== 500) throw new Error("JavaScript divrec failed");
  if (benchmarkTak() !== 7) throw new Error("JavaScript tak failed");
  if (length(benchmarkTakl()) !== 7) throw new Error("JavaScript takl failed");
  if (length(benchmarkNtakl()) !== 7) throw new Error("JavaScript ntakl failed");
  if (benchmarkCpstak() !== 4) throw new Error("JavaScript cpstak failed");
}
