import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const library = await readFile(new URL("src/objects.wat", root), "utf8");
const consumerFixture = String.raw`
  ;; This derived object proves that consumers can extend the base object header with their own fields.
  (type $payload_obj
    (sub $obj
      (struct
        (field $tag (ref $tag))
        (field $payload i32))))

  ;; This derived identity object proves that consumers can extend the identity header with their own fields.
  (type $payload_idobj
    (sub $idobj
      (struct
        (field $tag (ref $tag))
        (field $identity_hash (mut i32))
        (field $payload i32))))

  ;; This value-like object proves that future strings can extend ordinary objects without becoming identity objects.
  (type $stringish_obj
    (sub $obj
      (struct
        (field $tag (ref $tag))
        (field $content_hash i32))))

  ;; This independently declared packed byte array proves that plain byte arrays are structurally strings.
  (type $foreign_bytes
    (array (mut i8)))

  ;; Create a derived ordinary object with an application payload.
  (func $new_payload_obj
    (param $tag_value (ref $tag))
    (param $payload i32)
    (result (ref $payload_obj))
    (struct.new $payload_obj
      (local.get $tag_value)
      (local.get $payload)))

  ;; Return the application payload stored in a derived ordinary object.
  (func $payload_obj_value
    (param $value (ref $payload_obj))
    (result i32)
    (struct.get $payload_obj $payload (local.get $value)))

  ;; Create a derived identity object with a fresh hash and an application payload.
  (func $new_payload_idobj
    (param $tag_value (ref $tag))
    (param $payload i32)
    (result (ref $payload_idobj))
    (struct.new $payload_idobj
      (local.get $tag_value)
      (call $allocate_identity_hash)
      (local.get $payload)))

  ;; Return the application payload stored in a derived identity object.
  (func $payload_idobj_value
    (param $value (ref $payload_idobj))
    (result i32)
    (struct.get $payload_idobj $payload (local.get $value)))

  ;; Create a mock string-like value object with a cached content hash.
  (func $new_stringish_obj
    (param $tag_value (ref $tag))
    (param $content_hash i32)
    (result (ref $stringish_obj))
    (struct.new $stringish_obj
      (local.get $tag_value)
      (local.get $content_hash)))

  ;; Test whether an immediate i31 value is recognized as an object.
  (func $is_i31_obj
    (param $value i32)
    (result i32)
    (call $is_obj (ref.i31 (local.get $value))))

  ;; Test whether an immediate i31 value is recognized as an identity object.
  (func $is_i31_idobj
    (param $value i32)
    (result i32)
    (call $is_idobj (ref.i31 (local.get $value))))

  ;; Allocate an independently declared packed byte array for structural string tests.
  (func $new_foreign_bytes
    (param $byte_len i32)
    (result (ref $foreign_bytes))
    (array.new_default $foreign_bytes (local.get $byte_len)))

  ;; Compare two i32 inputs after representing them as immediate i31 language values.
  (func $is_equal_i31
    (param $first i32)
    (param $second i32)
    (result i32)
    (call $is_equal
      (ref.i31 (local.get $first))
      (ref.i31 (local.get $second))))

  ;; Test whether an i32 represented as an immediate i31 language value is hashable.
  (func $is_hashable_i31
    (param $value i32)
    (result i32)
    (call $is_hashable (ref.i31 (local.get $value))))

  ;; Hash an i32 after representing it as an immediate i31 language value.
  (func $hash_i31
    (param $value i32)
    (result i32)
    (call $hash (ref.i31 (local.get $value))))

  ;; Return the signed payload of a language integer after the caller has checked its value kind.
  (func $integer_value
    (param $value (ref eq))
    (result i32)
    (i31.get_s (ref.cast (ref i31) (local.get $value))))

  ;; Return nil through the exact opaque-reference signature used by macro modules.
  (func $abi_nil (result (ref eq)) (call $nil))

  ;; Test nil through the exact opaque-reference signature used by macro modules.
  (func $abi_is_nil (param $value (ref eq)) (result i32) (call $is_nil (local.get $value)))

  ;; Allocate a cons through the exact opaque-reference signature used by macro modules.
  (func $abi_cons
    (param $car (ref eq)) (param $cdr (ref eq)) (result (ref eq))
    (call $new_cons (local.get $car) (local.get $cdr)))

  ;; Test a cons through the exact opaque-reference signature used by macro modules.
  (func $abi_is_cons (param $value (ref eq)) (result i32) (call $is_cons (local.get $value)))

  ;; Read a cons car after validating the opaque value with the macro ABI predicate.
  (func $abi_car (param $value (ref eq)) (result (ref eq))
    (call $cons_car (ref.cast (ref $cons) (local.get $value))))

  ;; Read a cons cdr after validating the opaque value with the macro ABI predicate.
  (func $abi_cdr (param $value (ref eq)) (result (ref eq))
    (call $cons_cdr (ref.cast (ref $cons) (local.get $value))))

  ;; Replace a cons car through the opaque macro ABI.
  (func $abi_set_car (param $value (ref eq)) (param $car (ref eq))
    (call $set_cons_car (ref.cast (ref $cons) (local.get $value)) (local.get $car)))

  ;; Replace a cons cdr through the opaque macro ABI.
  (func $abi_set_cdr (param $value (ref eq)) (param $cdr (ref eq))
    (call $set_cons_cdr (ref.cast (ref $cons) (local.get $value)) (local.get $cdr)))

  ;; Construct a signed i31 value and trap rather than silently truncate an out-of-range i32.
  (func $abi_integer (param $value i32) (result (ref eq))
    (if
      (i32.or
        (i32.lt_s (local.get $value) (i32.const -1073741824))
        (i32.gt_s (local.get $value) (i32.const 1073741823)))
      (then unreachable))
    (ref.i31 (local.get $value)))

  ;; Test whether an opaque macro value is an immediate integer.
  (func $abi_is_integer (param $value (ref eq)) (result i32)
    (ref.test (ref i31) (local.get $value)))

  ;; Construct a canonical boolean through the opaque macro ABI.
  (func $abi_boolean (param $value i32) (result (ref eq)) (call $i32_to_bool (local.get $value)))

  ;; Test whether an opaque macro value is a canonical boolean.
  (func $abi_is_boolean (param $value (ref eq)) (result i32) (call $is_bool (local.get $value)))

  ;; Return a canonical boolean's i32 truth value through the opaque macro ABI.
  (func $abi_boolean_value (param $value (ref eq)) (result i32)
    (call $bool_to_i32 (ref.cast (ref $bool) (local.get $value))))

  ;; Allocate a packed byte string through the opaque macro ABI.
  (func $abi_string (param $byte_len i32) (result (ref eq)) (call $new_str (local.get $byte_len)))

  ;; Test whether an opaque macro value is a packed byte string.
  (func $abi_is_string (param $value (ref eq)) (result i32) (call $is_str (local.get $value)))

  ;; Return the byte length of a validated macro ABI string.
  (func $abi_string_length (param $value (ref eq)) (result i32)
    (array.len (ref.cast (ref $str) (local.get $value))))

  ;; Read one unsigned byte from a validated macro ABI string.
  (func $abi_string_byte (param $value (ref eq)) (param $index i32) (result i32)
    (call $str_byte_at (ref.cast (ref $str) (local.get $value)) (local.get $index)))

  ;; Initialize one byte in a newly allocated macro ABI string.
  (func $abi_string_set_byte (param $value (ref eq)) (param $index i32) (param $byte i32)
    (call $str_init_byte
      (ref.cast (ref $str) (local.get $value))
      (local.get $index)
      (local.get $byte)))

  ;; Intern a packed byte string as a canonical plain symbol.
  (func $abi_intern (param $name (ref eq)) (result (ref eq))
    (call $intern_str (ref.cast (ref $str) (local.get $name))))

  ;; Intern a packed byte string beneath a canonical plain module symbol.
  (func $abi_intern_qualified
    (param $module (ref eq)) (param $name (ref eq)) (result (ref eq))
    (local $module_symbol (ref $symbol))
    (local.set $module_symbol (ref.cast (ref $symbol) (local.get $module)))
    (if (call $symbol_has_module (local.get $module_symbol)) (then unreachable))
    (call $intern_str_module
      (local.get $module_symbol)
      (ref.cast (ref $str) (local.get $name))))

  ;; Test whether an opaque macro value is a symbol.
  (func $abi_is_symbol (param $value (ref eq)) (result i32) (call $is_symbol (local.get $value)))

  ;; Test whether a validated macro ABI symbol has a module qualifier.
  (func $abi_symbol_has_module (param $value (ref eq)) (result i32)
    (call $symbol_has_module (ref.cast (ref $symbol) (local.get $value))))

  ;; Return a qualified macro ABI symbol's module and trap for a plain symbol.
  (func $abi_symbol_module (param $value (ref eq)) (result (ref eq))
    (call $symbol_module (ref.cast (ref $symbol) (local.get $value))))

  ;; Return a validated macro ABI symbol's packed local-name string.
  (func $abi_symbol_name (param $value (ref eq)) (result (ref eq))
    (call $symbol_name (ref.cast (ref $symbol) (local.get $value))))

  ;; Compare two opaque macro ABI values with Idle equality.
  (func $abi_equal (param $first (ref eq)) (param $second (ref eq)) (result i32)
    (call $is_equal (local.get $first) (local.get $second)))

  ;; Test whether an opaque macro ABI value supports Idle hashing.
  (func $abi_is_hashable (param $value (ref eq)) (result i32)
    (call $is_hashable (local.get $value)))

  ;; Hash an opaque macro ABI value and trap when it is unsupported.
  (func $abi_hash (param $value (ref eq)) (result i32) (call $hash (local.get $value)))

  ;; Invoke the counter read slot at this source-level virtual call site.
  (func $call_counter_read
    (param $self (ref $counter))
    (result i32)
    (call_ref $counter_read_sig
      (local.get $self)
      (struct.get $counter_tag $read
        (struct.get $counter $tag (local.get $self)))))

  ;; Tail-invoke the counter read slot at this source-level virtual call site.
  (func $tail_call_counter_read
    (param $self (ref $counter))
    (result i32)
    (return_call_ref $counter_read_sig
      (local.get $self)
      (struct.get $counter_tag $read
        (struct.get $counter $tag (local.get $self)))))

  ;; Tail-invoke the statically known base implementation for an exact-class call site.
  (func $tail_call_counter_read_exact
    (param $self (ref $counter))
    (result i32)
    (return_call $counter_read (local.get $self)))

  ;; Tail-invoke the virtual countdown slot so recursive calls do not retain Wasm stack frames.
  (func $call_counter_countdown
    (param $self (ref $counter))
    (param $remaining i32)
    (result i32)
    (return_call_ref $counter_countdown_sig
      (local.get $self)
      (local.get $remaining)
      (struct.get $counter_tag $countdown
        (struct.get $counter $tag (local.get $self)))))

  ;; Invoke the subclass method through its fixed descriptor slot.
  (func $call_offset_counter_offset
    (param $self (ref $offset_counter))
    (result i32)
    (call_ref $offset_counter_offset_sig
      (local.get $self)
      (struct.get $offset_counter_tag $offset
        (struct.get $offset_counter $tag (local.get $self)))))

  ;; Return one when a value is an instance of the counter class or one of its subclasses.
  (func $is_counter_value
    (param $value (ref eq))
    (result i32)
    (ref.test (ref $counter) (local.get $value)))

  ;; Return one when a value is an instance of the offset-counter subclass.
  (func $is_offset_counter_value
    (param $value (ref eq))
    (result i32)
    (ref.test (ref $offset_counter) (local.get $value)))

  (export "new_tag" (func $new_tag))
  (export "new_obj" (func $new_obj))
  (export "is_obj" (func $is_obj))
  (export "obj_tag" (func $obj_tag))
  (export "has_tag" (func $has_tag))
  (export "new_idobj" (func $new_idobj))
  (export "is_idobj" (func $is_idobj))
  (export "idobj_hash" (func $idobj_hash))
  (export "new_payload_obj" (func $new_payload_obj))
  (export "payload_obj_value" (func $payload_obj_value))
  (export "new_payload_idobj" (func $new_payload_idobj))
  (export "payload_idobj_value" (func $payload_idobj_value))
  (export "new_stringish_obj" (func $new_stringish_obj))
  (export "is_i31_obj" (func $is_i31_obj))
  (export "is_i31_idobj" (func $is_i31_idobj))
  (export "new_str" (func $new_str))
  (export "str_init_byte" (func $str_init_byte))
  (export "is_str" (func $is_str))
  (export "str_byte_at" (func $str_byte_at))
  (export "is_equal_str" (func $is_equal_str))
  (export "str_hash" (func $str_hash))
  (export "i32_to_bool" (func $i32_to_bool))
  (export "is_bool" (func $is_bool))
  (export "bool_to_i32" (func $bool_to_i32))
  (export "is_equal" (func $is_equal))
  (export "is_hashable" (func $is_hashable))
  (export "hash" (func $hash))
  (export "new_foreign_bytes" (func $new_foreign_bytes))
  (export "is_equal_i31" (func $is_equal_i31))
  (export "is_hashable_i31" (func $is_hashable_i31))
  (export "hash_i31" (func $hash_i31))
  (export "memory" (memory $source_memory))
  (export "nil" (func $nil))
  (export "is_nil" (func $is_nil))
  (export "new_cons" (func $new_cons))
  (export "is_cons" (func $is_cons))
  (export "cons_car" (func $cons_car))
  (export "cons_cdr" (func $cons_cdr))
  (export "set_cons_car" (func $set_cons_car))
  (export "set_cons_cdr" (func $set_cons_cdr))
  (export "is_symbol" (func $is_symbol))
  (export "symbol_name_hash" (func $symbol_name_hash))
  (export "symbol_has_module" (func $symbol_has_module))
  (export "symbol_module" (func $symbol_module))
  (export "intern_memory" (func $intern_memory))
  (export "intern_memory_module" (func $intern_memory_module))
  (export "read_all" (func $read_all))
  (export "reader_result_ok" (func $reader_result_ok))
  (export "reader_result_value" (func $reader_result_value))
  (export "reader_result_error_code" (func $reader_result_error_code))
  (export "reader_result_error_offset" (func $reader_result_error_offset))
  (export "value_kind" (func $value_kind))
  (export "integer_value" (func $integer_value))
  (export "symbol_name_to_memory" (func $symbol_name_to_memory))
  (export "abi_nil" (func $abi_nil))
  (export "abi_is_nil" (func $abi_is_nil))
  (export "abi_cons" (func $abi_cons))
  (export "abi_is_cons" (func $abi_is_cons))
  (export "abi_car" (func $abi_car))
  (export "abi_cdr" (func $abi_cdr))
  (export "abi_set_car" (func $abi_set_car))
  (export "abi_set_cdr" (func $abi_set_cdr))
  (export "abi_list_length" (func $list_length))
  (export "abi_list_reverse_prepend" (func $list_reverse_prepend))
  (export "abi_integer" (func $abi_integer))
  (export "abi_is_integer" (func $abi_is_integer))
  (export "abi_integer_value" (func $integer_value))
  (export "abi_boolean" (func $abi_boolean))
  (export "abi_is_boolean" (func $abi_is_boolean))
  (export "abi_boolean_value" (func $abi_boolean_value))
  (export "abi_string" (func $abi_string))
  (export "abi_is_string" (func $abi_is_string))
  (export "abi_string_length" (func $abi_string_length))
  (export "abi_string_byte" (func $abi_string_byte))
  (export "abi_string_set_byte" (func $abi_string_set_byte))
  (export "abi_intern" (func $abi_intern))
  (export "abi_intern_qualified" (func $abi_intern_qualified))
  (export "abi_is_symbol" (func $abi_is_symbol))
  (export "abi_symbol_has_module" (func $abi_symbol_has_module))
  (export "abi_symbol_module" (func $abi_symbol_module))
  (export "abi_symbol_name" (func $abi_symbol_name))
  (export "abi_equal" (func $abi_equal))
  (export "abi_is_hashable" (func $abi_is_hashable))
  (export "abi_hash" (func $abi_hash))
  (export "new_counter" (func $new_counter))
  (export "new_offset_counter" (func $new_offset_counter))
  (export "call_counter_read" (func $call_counter_read))
  (export "tail_call_counter_read" (func $tail_call_counter_read))
  (export "tail_call_counter_read_exact" (func $tail_call_counter_read_exact))
  (export "call_counter_countdown" (func $call_counter_countdown))
  (export "call_offset_counter_offset" (func $call_offset_counter_offset))
  (export "is_counter_value" (func $is_counter_value))
  (export "is_offset_counter_value" (func $is_offset_counter_value))
`;

const buildDirectory = new URL("build/", root);
const watPath = new URL("objects.wat", buildDirectory);
const wasmPath = new URL("objects.wasm", buildDirectory);
await mkdir(buildDirectory, { recursive: true });
await writeFile(watPath, `(module\n${library}\n${consumerFixture}\n)\n`);

const child = spawn(
  fileURLToPath(new URL("node_modules/.bin/wasm-as", root)),
  [
    fileURLToPath(watPath),
    "-o",
    fileURLToPath(wasmPath),
    "--enable-gc",
    "--enable-reference-types",
    "--enable-extended-const",
    "--enable-tail-call",
  ],
  { stdio: "inherit" },
);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (exitCode !== 0) process.exitCode = exitCode ?? 1;
