  ;; A tag is a reference-valued marker that identifies an object's runtime type.
  (type $tag
    (sub (struct)))

  ;; An object stores its runtime tag in the first field so derived structs preserve the header layout.
  (type $obj
    (sub
      (struct
        (field $tag (ref $tag)))))

  ;; An identity object adds an API-stable i32 hash whose internal mutability keeps this structural type distinct from ordinary extensions.
  (type $idobj
    (sub $obj
      (struct
        (field $tag (ref $tag))
        (field $identity_hash (mut i32)))))

  ;; A string is a directly allocated mutable byte array that becomes immutable by convention once published.
  (type $str
    (array (mut i8)))

  ;; A boolean object stores its canonical truth value alongside the ordinary object tag header.
  (type $bool
    (sub $obj
      (struct
        (field $tag (ref $tag))
        (field $value i8))))

  ;; Nil is the canonical empty-list object and carries no payload beyond its tag.
  (type $nil
    (sub $obj
      (struct
        (field $tag (ref $tag)))))

  ;; A cons is an identity object with mutable non-null car and cdr language values.
  (type $cons
    (sub $idobj
      (struct
        (field $tag (ref $tag))
        (field $identity_hash (mut i32))
        (field $car (mut (ref eq)))
        (field $cdr (mut (ref eq))))))

  (rec
    ;; A symbol is an identity object whose nullable module is null for plain names or another canonical plain symbol for qualified names.
    (type $symbol
      (sub $idobj
        (struct
          (field $tag (ref $tag))
          (field $identity_hash (mut i32))
          (field $module (ref null $symbol))
          (field $name (ref $str))
          (field $name_hash i32)))))

  ;; A reader frame incrementally appends datums to one proper list without recursive parser calls.
  (type $reader_frame
    (struct
      (field $parent (ref eq))
      (field $head (mut (ref eq)))
      (field $tail (mut (ref eq)))
      (field $quotes i32)))

  ;; A reader result distinguishes successful nil values from failures with an explicit flag and error data.
  (type $reader_result
    (struct
      (field $ok i8)
      (field $value (ref eq))
      (field $error_code i32)
      (field $error_offset i32)))

  (rec
    ;; This signature describes the virtual read method introduced by the counter class.
    (type $counter_read_sig
      (func
        (param (ref $counter))
        (result i32)))

    ;; This signature describes the tail-recursive virtual countdown method introduced by the counter class.
    (type $counter_countdown_sig
      (func
        (param (ref $counter))
        (param i32)
        (result i32)))

    ;; A counter tag is an immutable class descriptor with fixed read and countdown method slots.
    (type $counter_tag
      (sub $tag
        (struct
          (field $read (ref $counter_read_sig))
          (field $countdown (ref $counter_countdown_sig)))))

    ;; A counter is an ordinary object with a narrowed class descriptor and one fixed mutable value field.
    (type $counter
      (sub $obj
        (struct
          (field $tag (ref $counter_tag))
          (field $value (mut i32))))))

  (rec
    ;; This signature describes the virtual method introduced by the offset-counter subclass.
    (type $offset_counter_offset_sig
      (func
        (param (ref $offset_counter))
        (result i32)))

    ;; An offset-counter tag inherits the counter slots and appends one fixed subclass method slot.
    (type $offset_counter_tag
      (sub $counter_tag
        (struct
          (field $read (ref $counter_read_sig))
          (field $countdown (ref $counter_countdown_sig))
          (field $offset (ref $offset_counter_offset_sig)))))

    ;; An offset counter inherits the counter layout and appends one fixed immutable offset field.
    (type $offset_counter
      (sub $counter
        (struct
          (field $tag (ref $offset_counter_tag))
          (field $value (mut i32))
          (field $offset i32)))))

  ;; This counter supplies successive identity hashes and intentionally wraps after all i32 bit patterns have been used.
  (global $next_identity_hash (mut i32) (i32.const 1))

  ;; This private tag identifies the two canonical boolean objects.
  (global $bool_tag (ref $tag) (struct.new $tag))

  ;; This singleton is the only false boolean produced by the library.
  (global $false_value (ref $bool)
    (struct.new $bool
      (global.get $bool_tag)
      (i32.const 0)))

  ;; This singleton is the only true boolean produced by the library.
  (global $true_value (ref $bool)
    (struct.new $bool
      (global.get $bool_tag)
      (i32.const 1)))

  ;; This private tag identifies the canonical nil singleton.
  (global $nil_tag (ref $tag) (struct.new $tag))

  ;; This singleton represents both the empty list and the #nil reader literal.
  (global $nil_value (ref $nil)
    (struct.new $nil (global.get $nil_tag)))

  ;; This private tag identifies every cons cell.
  (global $cons_tag (ref $tag) (struct.new $tag))

  ;; This private tag identifies every symbol object.
  (global $symbol_tag (ref $tag) (struct.new $tag))

  ;; This strong registry is always nil or a proper cons list of interned symbols.
  (global $interned_symbols (mut (ref eq)) (global.get $nil_value))

  ;; This linear memory stages reader input and copied symbol-name output at offset zero.
  (memory $source_memory 1)

  ;; Create a fresh tag whose reference identity distinguishes it from every other live tag.
  (func $new_tag (result (ref $tag))
    (struct.new $tag))

  ;; Reserve and return the next identity hash for a newly allocated identity object.
  (func $allocate_identity_hash (result i32)
    (local $hash i32)
    (local.set $hash (global.get $next_identity_hash))
    (global.set $next_identity_hash
      (i32.add (local.get $hash) (i32.const 1)))
    (local.get $hash))

  ;; Create a base object carrying the supplied runtime tag.
  (func $new_obj
    (param $tag_value (ref $tag))
    (result (ref $obj))
    (struct.new $obj (local.get $tag_value)))

  ;; Return one when the value has the object header layout and zero otherwise.
  (func $is_obj
    (param $value (ref eq))
    (result i32)
    (ref.test (ref $obj) (local.get $value)))

  ;; Return the runtime tag stored in an object's header.
  (func $obj_tag
    (param $value (ref $obj))
    (result (ref $tag))
    (struct.get $obj $tag (local.get $value)))

  ;; Return one when an object's stored tag is the supplied tag reference and zero otherwise.
  (func $has_tag
    (param $value (ref $obj))
    (param $tag_value (ref $tag))
    (result i32)
    (ref.eq
      (struct.get $obj $tag (local.get $value))
      (local.get $tag_value)))

  ;; Create an identity object carrying the supplied tag and a newly allocated i32 hash.
  (func $new_idobj
    (param $tag_value (ref $tag))
    (result (ref $idobj))
    (struct.new $idobj
      (local.get $tag_value)
      (call $allocate_identity_hash)))

  ;; Return one when the value has the identity-object layout and zero otherwise.
  (func $is_idobj
    (param $value (ref eq))
    (result i32)
    (ref.test (ref $idobj) (local.get $value)))

  ;; Return the stable i32 hash stored in an identity object.
  (func $idobj_hash
    (param $value (ref $idobj))
    (result i32)
    (struct.get $idobj $identity_hash (local.get $value)))

  ;; Return the canonical nil singleton.
  (func $nil (result (ref $nil))
    (global.get $nil_value))

  ;; Return one exactly when the value is the canonical nil singleton.
  (func $is_nil
    (param $value (ref eq))
    (result i32)
    (ref.eq (local.get $value) (global.get $nil_value)))

  ;; Allocate a mutable identity cons whose car and cdr are the supplied non-null language values.
  (func $new_cons
    (param $car (ref eq))
    (param $cdr (ref eq))
    (result (ref $cons))
    (struct.new $cons
      (global.get $cons_tag)
      (call $allocate_identity_hash)
      (local.get $car)
      (local.get $cdr)))

  ;; Return one when the value has the cons layout and zero otherwise.
  (func $is_cons
    (param $value (ref eq))
    (result i32)
    (ref.test (ref $cons) (local.get $value)))

  ;; Return the car stored in a cons.
  (func $cons_car
    (param $value (ref $cons))
    (result (ref eq))
    (struct.get $cons $car (local.get $value)))

  ;; Return the cdr stored in a cons.
  (func $cons_cdr
    (param $value (ref $cons))
    (result (ref eq))
    (struct.get $cons $cdr (local.get $value)))

  ;; Return the length of a proper list and trap when a non-cons tail is encountered.
  (func $list_length
    (param $value (ref eq))
    (result i32)
    (local $cursor (ref eq))
    (local $length i32)
    (local.set $cursor (local.get $value))
    (block $done
      (loop $next
        (br_if $done (call $is_nil (local.get $cursor)))
        (if (i32.eqz (call $is_cons (local.get $cursor)))
          (then unreachable))
        (local.set $length (i32.add (local.get $length) (i32.const 1)))
        (local.set $cursor
          (call $cons_cdr
            (ref.cast (ref $cons) (local.get $cursor))))
        (br $next)))
    (local.get $length))

  ;; Copy a proper list in reverse order before an arbitrary tail.
  (func $list_reverse_prepend
    (param $value (ref eq))
    (param $tail (ref eq))
    (result (ref eq))
    (local $cursor (ref eq))
    (local $result (ref eq))
    (local.set $cursor (local.get $value))
    (local.set $result (local.get $tail))
    (block $done
      (loop $next
        (br_if $done (call $is_nil (local.get $cursor)))
        (if (i32.eqz (call $is_cons (local.get $cursor)))
          (then unreachable))
        (local.set $result
          (call $new_cons
            (call $cons_car
              (ref.cast (ref $cons) (local.get $cursor)))
            (local.get $result)))
        (local.set $cursor
          (call $cons_cdr
            (ref.cast (ref $cons) (local.get $cursor))))
        (br $next)))
    (local.get $result))

  ;; Replace the car of a cons with a non-null language value.
  (func $set_cons_car
    (param $value (ref $cons))
    (param $car (ref eq))
    (struct.set $cons $car (local.get $value) (local.get $car)))

  ;; Replace the cdr of a cons with a non-null language value.
  (func $set_cons_cdr
    (param $value (ref $cons))
    (param $cdr (ref eq))
    (struct.set $cons $cdr (local.get $value) (local.get $cdr)))

  ;; Return one when the value has the symbol layout and zero otherwise.
  (func $is_symbol
    (param $value (ref eq))
    (result i32)
    (ref.test (ref $symbol) (local.get $value)))

  ;; Return one when a symbol is qualified by a non-null plain module symbol.
  (func $symbol_has_module
    (param $value (ref $symbol))
    (result i32)
    (ref.is_null (struct.get $symbol $module (local.get $value)))
    (i32.eqz))

  ;; Return a qualified symbol's non-null plain module symbol and trap for a plain symbol.
  (func $symbol_module
    (param $value (ref $symbol))
    (result (ref $symbol))
    (ref.as_non_null (struct.get $symbol $module (local.get $value))))

  ;; Return the immutable UTF-8 name stored in a symbol.
  (func $symbol_name
    (param $value (ref $symbol))
    (result (ref $str))
    (struct.get $symbol $name (local.get $value)))

  ;; Return the cached content hash of a symbol's UTF-8 name.
  (func $symbol_name_hash
    (param $value (ref $symbol))
    (result i32)
    (struct.get $symbol $name_hash (local.get $value)))

  ;; Allocate the final zero-filled byte array for a string of the requested byte length.
  (func $new_str
    (param $byte_len i32)
    (result (ref $str))
    (array.new_default $str (local.get $byte_len)))

  ;; Store one construction-time byte into a string before the string is published.
  (func $str_init_byte
    (param $value (ref $str))
    (param $index i32)
    (param $byte i32)
    (array.set $str
      (local.get $value)
      (local.get $index)
      (local.get $byte)))

  ;; Return one when the value has the plain mutable packed-byte array shape and zero otherwise.
  (func $is_str
    (param $value (ref eq))
    (result i32)
    (ref.test (ref $str) (local.get $value)))

  ;; Return one string byte as an unsigned i32 and trap when the index is out of bounds.
  (func $str_byte_at
    (param $value (ref $str))
    (param $index i32)
    (result i32)
    (array.get_u $str
      (local.get $value)
      (local.get $index)))

  ;; Compare two strings byte-for-byte and return one exactly when their UTF-8 encodings match.
  (func $is_equal_str
    (param $first (ref $str))
    (param $second (ref $str))
    (result i32)
    (local $byte_len i32)
    (local $index i32)
    (if
      (i32.ne
        (array.len (local.get $first))
        (array.len (local.get $second)))
      (then (return (i32.const 0))))
    (local.set $byte_len (array.len (local.get $first)))
    (loop $compare_next
      (if
        (i32.ge_u (local.get $index) (local.get $byte_len))
        (then (return (i32.const 1))))
      (if
        (i32.ne
          (array.get_u $str (local.get $first) (local.get $index))
          (array.get_u $str (local.get $second) (local.get $index)))
        (then (return (i32.const 0))))
      (local.set $index
        (i32.add (local.get $index) (i32.const 1)))
      (br $compare_next))
    (i32.const 0))

  ;; Hash all string bytes with scalar 32-bit FNV-1a and return the resulting bit pattern.
  (func $str_hash
    (param $value (ref $str))
    (result i32)
    (local $byte_len i32)
    (local $index i32)
    (local $hash i32)
    (local.set $byte_len (array.len (local.get $value)))
    (local.set $hash (i32.const 0x811c9dc5))
    (block $hashed
      (loop $hash_next
        (br_if $hashed
          (i32.ge_u (local.get $index) (local.get $byte_len)))
        (local.set $hash
          (i32.mul
            (i32.xor
              (local.get $hash)
              (array.get_u $str
                (local.get $value)
                (local.get $index)))
            (i32.const 0x01000193)))
        (local.set $index
          (i32.add (local.get $index) (i32.const 1)))
        (br $hash_next)))
    (local.get $hash))

  ;; Return the canonical boolean singleton corresponding to whether the input is nonzero.
  (func $i32_to_bool
    (param $value i32)
    (result (ref $bool))
    (if (result (ref $bool))
      (local.get $value)
      (then (global.get $true_value))
      (else (global.get $false_value))))

  ;; Return one exactly when the value is either canonical boolean singleton.
  (func $is_bool
    (param $value (ref eq))
    (result i32)
    (i32.or
      (ref.eq (local.get $value) (global.get $false_value))
      (ref.eq (local.get $value) (global.get $true_value))))

  ;; Return zero for the canonical false object and one for the canonical true object.
  (func $bool_to_i32
    (param $value (ref $bool))
    (result i32)
    (struct.get_u $bool $value (local.get $value)))

  ;; Mix an i32 bit pattern so nearby immediate integers distribute across hash buckets.
  (func $mix_i32
    (param $value i32)
    (result i32)
    (local $mixed i32)
    (local.set $mixed (local.get $value))
    (local.set $mixed
      (i32.xor
        (local.get $mixed)
        (i32.shr_u (local.get $mixed) (i32.const 16))))
    (local.set $mixed
      (i32.mul (local.get $mixed) (i32.const 0x7feb352d)))
    (local.set $mixed
      (i32.xor
        (local.get $mixed)
        (i32.shr_u (local.get $mixed) (i32.const 15))))
    (local.set $mixed
      (i32.mul (local.get $mixed) (i32.const 0x846ca68b)))
    (i32.xor
      (local.get $mixed)
      (i32.shr_u (local.get $mixed) (i32.const 16))))

  ;; Compare two language values by immediate value, canonical identity, or string contents as appropriate.
  (func $is_equal
    (param $first (ref eq))
    (param $second (ref eq))
    (result i32)
    (if
      (ref.eq (local.get $first) (local.get $second))
      (then (return (i32.const 1))))
    (if (result i32)
      (i32.and
        (ref.test (ref $str) (local.get $first))
        (ref.test (ref $str) (local.get $second)))
      (then
        (call $is_equal_str
          (ref.cast (ref $str) (local.get $first))
          (ref.cast (ref $str) (local.get $second))))
      (else (i32.const 0))))

  ;; Return one for values supported by the generic hash function and zero for all other values.
  (func $is_hashable
    (param $value (ref eq))
    (result i32)
    (i32.or
      (ref.test (ref i31) (local.get $value))
      (i32.or
        (ref.test (ref $str) (local.get $value))
        (i32.or
          (call $is_bool (local.get $value))
          (i32.or
            (call $is_nil (local.get $value))
            (ref.test (ref $idobj) (local.get $value)))))))

  ;; Hash an immediate integer, string, boolean, or identity object and trap for an unsupported value.
  (func $hash
    (param $value (ref eq))
    (result i32)
    (if (result i32)
      (ref.test (ref i31) (local.get $value))
      (then
        (call $mix_i32
          (i31.get_s
            (ref.cast (ref i31) (local.get $value)))))
      (else
        (if (result i32)
          (ref.test (ref $str) (local.get $value))
          (then
            (call $str_hash
              (ref.cast (ref $str) (local.get $value))))
          (else
            (if (result i32)
              (call $is_bool (local.get $value))
              (then
                (call $mix_i32
                  (ref.eq
                    (local.get $value)
                    (global.get $true_value))))
              (else
                (if (result i32)
                  (call $is_nil (local.get $value))
                  (then (i32.const 0x4e494c))
                  (else
                    (if (result i32)
                      (ref.test (ref $idobj) (local.get $value))
                      (then
                        (call $idobj_hash
                          (ref.cast (ref $idobj) (local.get $value))))
                      (else (unreachable))))))))))))

  ;; Copy a staged memory byte slice into a newly allocated UTF-8 string array.
  (func $memory_to_str
    (param $offset i32)
    (param $byte_len i32)
    (result (ref $str))
    (local $value (ref $str))
    (local $index i32)
    (local.set $value (call $new_str (local.get $byte_len)))
    (block $copied
      (loop $copy_next
        (br_if $copied (i32.ge_u (local.get $index) (local.get $byte_len)))
        (array.set $str
          (local.get $value)
          (local.get $index)
          (i32.load8_u
            (i32.add (local.get $offset) (local.get $index))))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $copy_next)))
    (local.get $value))

  ;; Hash a staged memory byte slice with scalar 32-bit FNV-1a.
  (func $hash_memory
    (param $offset i32)
    (param $byte_len i32)
    (result i32)
    (local $index i32)
    (local $hash i32)
    (local.set $hash (i32.const 0x811c9dc5))
    (block $hashed
      (loop $hash_next
        (br_if $hashed (i32.ge_u (local.get $index) (local.get $byte_len)))
        (local.set $hash
          (i32.mul
            (i32.xor
              (local.get $hash)
              (i32.load8_u
                (i32.add (local.get $offset) (local.get $index))))
            (i32.const 0x01000193)))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $hash_next)))
    (local.get $hash))

  ;; Compare an immutable string with a staged memory byte slice without allocating a probe string.
  (func $is_equal_str_memory
    (param $value (ref $str))
    (param $offset i32)
    (param $byte_len i32)
    (result i32)
    (local $index i32)
    (if
      (i32.ne (array.len (local.get $value)) (local.get $byte_len))
      (then (return (i32.const 0))))
    (loop $compare_next
      (if
        (i32.ge_u (local.get $index) (local.get $byte_len))
        (then (return (i32.const 1))))
      (if
        (i32.ne
          (array.get_u $str (local.get $value) (local.get $index))
          (i32.load8_u
            (i32.add (local.get $offset) (local.get $index))))
        (then (return (i32.const 0))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $compare_next))
    (i32.const 0))

  ;; Allocate an interned symbol with its optional module, immutable local name, and cached content hash.
  (func $new_symbol
    (param $module (ref null $symbol))
    (param $name (ref $str))
    (param $name_hash i32)
    (result (ref $symbol))
    (struct.new $symbol
      (global.get $symbol_tag)
      (call $allocate_identity_hash)
      (local.get $module)
      (local.get $name)
      (local.get $name_hash)))

  ;; Intern an existing string under an optional canonical module by scanning the strong symbol registry.
  (func $intern_str_module
    (param $module (ref null $symbol))
    (param $name (ref $str))
    (result (ref $symbol))
    (local $name_hash i32)
    (local $cursor (ref eq))
    (local $cell (ref $cons))
    (local $candidate (ref $symbol))
    (local $created (ref $symbol))
    (local.set $name_hash (call $str_hash (local.get $name)))
    (local.set $cursor (global.get $interned_symbols))
    (block $missing
      (loop $scan
        (br_if $missing (call $is_nil (local.get $cursor)))
        (local.set $cell (ref.cast (ref $cons) (local.get $cursor)))
        (local.set $candidate
          (ref.cast (ref $symbol) (call $cons_car (local.get $cell))))
        (if
          (i32.and
            (ref.eq
              (struct.get $symbol $module (local.get $candidate))
              (local.get $module))
            (i32.and
              (i32.eq
                (call $symbol_name_hash (local.get $candidate))
                (local.get $name_hash))
              (call $is_equal_str
                (call $symbol_name (local.get $candidate))
                (local.get $name))))
          (then (return (local.get $candidate))))
        (local.set $cursor (call $cons_cdr (local.get $cell)))
        (br $scan)))
    (local.set $created
      (call $new_symbol
        (local.get $module)
        (local.get $name)
        (local.get $name_hash)))
    (global.set $interned_symbols
      (call $new_cons
        (local.get $created)
        (global.get $interned_symbols)))
    (local.get $created))

  ;; Intern an existing string as a plain default-module symbol.
  (func $intern_str
    (param $name (ref $str))
    (result (ref $symbol))
    (call $intern_str_module
      (ref.null $symbol)
      (local.get $name)))

  ;; Intern a staged local name under an optional canonical module without allocating on a registry hit.
  (func $intern_memory_module
    (param $module (ref null $symbol))
    (param $offset i32)
    (param $byte_len i32)
    (result (ref $symbol))
    (local $name_hash i32)
    (local $cursor (ref eq))
    (local $cell (ref $cons))
    (local $candidate (ref $symbol))
    (local $created (ref $symbol))
    (local.set $name_hash (call $hash_memory (local.get $offset) (local.get $byte_len)))
    (local.set $cursor (global.get $interned_symbols))
    (block $missing
      (loop $scan
        (br_if $missing (call $is_nil (local.get $cursor)))
        (local.set $cell (ref.cast (ref $cons) (local.get $cursor)))
        (local.set $candidate
          (ref.cast (ref $symbol) (call $cons_car (local.get $cell))))
        (if
          (i32.and
            (ref.eq
              (struct.get $symbol $module (local.get $candidate))
              (local.get $module))
            (i32.and
              (i32.eq
                (call $symbol_name_hash (local.get $candidate))
                (local.get $name_hash))
              (call $is_equal_str_memory
                (call $symbol_name (local.get $candidate))
                (local.get $offset)
                (local.get $byte_len))))
          (then (return (local.get $candidate))))
        (local.set $cursor (call $cons_cdr (local.get $cell)))
        (br $scan)))
    (local.set $created
      (call $new_symbol
        (local.get $module)
        (call $memory_to_str (local.get $offset) (local.get $byte_len))
        (local.get $name_hash)))
    (global.set $interned_symbols
      (call $new_cons
        (local.get $created)
        (global.get $interned_symbols)))
    (local.get $created))

  ;; Intern a staged token as a plain default-module symbol.
  (func $intern_memory
    (param $offset i32)
    (param $byte_len i32)
    (result (ref $symbol))
    (call $intern_memory_module
      (ref.null $symbol)
      (local.get $offset)
      (local.get $byte_len)))

  ;; Return the canonical interned quote symbol used by reader abbreviation expansion.
  (func $intern_quote (result (ref $symbol))
    (call $intern_str
      (array.new_fixed $str 5
        (i32.const 0x71)
        (i32.const 0x75)
        (i32.const 0x6f)
        (i32.const 0x74)
        (i32.const 0x65))))

  ;; Append one datum to a mutable reader frame using exactly one new cons cell.
  (func $reader_append
    (param $frame (ref $reader_frame))
    (param $datum (ref eq))
    (local $cell (ref $cons))
    (local.set $cell (call $new_cons (local.get $datum) (global.get $nil_value)))
    (if
      (call $is_nil (struct.get $reader_frame $head (local.get $frame)))
      (then
        (struct.set $reader_frame $head (local.get $frame) (local.get $cell)))
      (else
        (call $set_cons_cdr
          (ref.cast (ref $cons)
            (struct.get $reader_frame $tail (local.get $frame)))
          (local.get $cell))))
    (struct.set $reader_frame $tail (local.get $frame) (local.get $cell)))

  ;; Wrap a datum in one canonical quote list for each pending apostrophe.
  (func $reader_wrap_quotes
    (param $datum (ref eq))
    (param $count i32)
    (result (ref eq))
    (local $wrapped (ref eq))
    (local.set $wrapped (local.get $datum))
    (block $done
      (loop $wrap
        (br_if $done (i32.eqz (local.get $count)))
        (local.set $wrapped
          (call $new_cons
            (call $intern_quote)
            (call $new_cons (local.get $wrapped) (global.get $nil_value))))
        (local.set $count (i32.sub (local.get $count) (i32.const 1)))
        (br $wrap)))
    (local.get $wrapped))

  ;; Return one for ASCII bytes treated as reader whitespace and zero otherwise.
  (func $is_reader_space
    (param $byte i32)
    (result i32)
    (i32.or
      (i32.eq (local.get $byte) (i32.const 0x20))
      (i32.or
        (i32.eq (local.get $byte) (i32.const 0x09))
        (i32.or
          (i32.eq (local.get $byte) (i32.const 0x0a))
          (i32.or
            (i32.eq (local.get $byte) (i32.const 0x0d))
            (i32.eq (local.get $byte) (i32.const 0x0c)))))))

  ;; Return one for a reader punctuation byte deliberately excluded from this minimal syntax.
  (func $is_unsupported_reader_byte
    (param $byte i32)
    (result i32)
    (i32.or
      (i32.eq (local.get $byte) (i32.const 0x22))
      (i32.or
        (i32.eq (local.get $byte) (i32.const 0x60))
        (i32.or
          (i32.eq (local.get $byte) (i32.const 0x2c))
          (i32.eq (local.get $byte) (i32.const 0x3b))))))

  ;; Return the sole non-edge colon index in a token, minus one for none, or minus two for malformed qualification.
  (func $qualified_token_colon
    (param $offset i32)
    (param $byte_len i32)
    (result i32)
    (local $index i32)
    (local $colon i32)
    (local.set $colon (i32.const -1))
    (block $scanned
      (loop $scan
        (br_if $scanned (i32.ge_u (local.get $index) (local.get $byte_len)))
        (if
          (i32.eq
            (i32.load8_u (i32.add (local.get $offset) (local.get $index)))
            (i32.const 0x3a))
          (then
            (if
              (i32.ne (local.get $colon) (i32.const -1))
              (then (return (i32.const -2))))
            (local.set $colon (local.get $index))))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $scan)))
    (if
      (i32.or
        (i32.eqz (local.get $colon))
        (i32.eq
          (local.get $colon)
          (i32.sub (local.get $byte_len) (i32.const 1))))
      (then (return (i32.const -2))))
    (local.get $colon))

  ;; Classify a token as symbol, valid integer, or overflowing integer without allocating.
  (func $integer_token_kind
    (param $offset i32)
    (param $byte_len i32)
    (result i32)
    (local $index i32)
    (local $byte i32)
    (local $limit i32)
    (local $magnitude i32)
    (local $digit i32)
    (if (i32.eqz (local.get $byte_len)) (then (return (i32.const 0))))
    (local.set $byte (i32.load8_u (local.get $offset)))
    (local.set $limit (i32.const 1073741823))
    (if
      (i32.or
        (i32.eq (local.get $byte) (i32.const 0x2b))
        (i32.eq (local.get $byte) (i32.const 0x2d)))
      (then
        (if
          (i32.eq (local.get $byte) (i32.const 0x2d))
          (then (local.set $limit (i32.const 1073741824))))
        (local.set $index (i32.const 1))))
    (if
      (i32.ge_u (local.get $index) (local.get $byte_len))
      (then (return (i32.const 0))))
    (loop $digits
      (local.set $byte
        (i32.load8_u (i32.add (local.get $offset) (local.get $index))))
      (if
        (i32.or
          (i32.lt_u (local.get $byte) (i32.const 0x30))
          (i32.gt_u (local.get $byte) (i32.const 0x39)))
        (then (return (i32.const 0))))
      (local.set $digit (i32.sub (local.get $byte) (i32.const 0x30)))
      (if
        (i32.gt_u
          (local.get $magnitude)
          (i32.div_u
            (i32.sub (local.get $limit) (local.get $digit))
            (i32.const 10)))
        (then (return (i32.const 2))))
      (local.set $magnitude
        (i32.add
          (i32.mul (local.get $magnitude) (i32.const 10))
          (local.get $digit)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br_if $digits (i32.lt_u (local.get $index) (local.get $byte_len))))
    (i32.const 1))

  ;; Parse a token already known to be a valid signed i31 decimal integer.
  (func $integer_token_value
    (param $offset i32)
    (param $byte_len i32)
    (result i32)
    (local $index i32)
    (local $negative i32)
    (local $magnitude i32)
    (local $byte i32)
    (local.set $byte (i32.load8_u (local.get $offset)))
    (if
      (i32.or
        (i32.eq (local.get $byte) (i32.const 0x2b))
        (i32.eq (local.get $byte) (i32.const 0x2d)))
      (then
        (local.set $negative
          (i32.eq (local.get $byte) (i32.const 0x2d)))
        (local.set $index (i32.const 1))))
    (loop $digits
      (local.set $magnitude
        (i32.add
          (i32.mul (local.get $magnitude) (i32.const 10))
          (i32.sub
            (i32.load8_u (i32.add (local.get $offset) (local.get $index)))
            (i32.const 0x30))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br_if $digits (i32.lt_u (local.get $index) (local.get $byte_len))))
    (if (result i32)
      (local.get $negative)
      (then (i32.sub (i32.const 0) (local.get $magnitude)))
      (else (local.get $magnitude))))

  ;; Construct a successful reader result with error code and offset set to zero even when the value is nil.
  (func $reader_success
    (param $value (ref eq))
    (result (ref $reader_result))
    (struct.new $reader_result
      (i32.const 1)
      (local.get $value)
      (i32.const 0)
      (i32.const 0)))

  ;; Construct a failed reader result carrying nil plus a stable code and byte offset.
  (func $reader_failure
    (param $code i32)
    (param $offset i32)
    (result (ref $reader_result))
    (struct.new $reader_result
      (i32.const 0)
      (global.get $nil_value)
      (local.get $code)
      (local.get $offset)))

  ;; Parse every staged source form into one proper top-level cons list using explicit GC frames.
  (func $read_all
    (param $byte_len i32)
    (result (ref $reader_result))
    (local $offset i32)
    (local $byte i32)
    (local $pending_quotes i32)
    (local $token_start i32)
    (local $token_len i32)
    (local $escape_offset i32)
    (local $integer_kind i32)
    (local $qualified_colon i32)
    (local $module_symbol (ref null $symbol))
    (local $root (ref $reader_frame))
    (local $frame (ref $reader_frame))
    (local $parent (ref $reader_frame))
    (local $completed (ref eq))
    (local $datum (ref eq))
    (local.set $root
      (struct.new $reader_frame
        (global.get $nil_value)
        (global.get $nil_value)
        (global.get $nil_value)
        (i32.const 0)))
    (local.set $frame (local.get $root))
    (local.set $parent (local.get $root))
    (local.set $completed (global.get $nil_value))
    (local.set $datum (global.get $nil_value))
    (loop $read_next
      (block $space_done
        (loop $skip_space
          (br_if $space_done
            (i32.ge_u (local.get $offset) (local.get $byte_len)))
          (local.set $byte (i32.load8_u (local.get $offset)))
          (br_if $space_done
            (i32.eqz (call $is_reader_space (local.get $byte))))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (br $skip_space)))
      (if
        (i32.ge_u (local.get $offset) (local.get $byte_len))
        (then
          (if
            (local.get $pending_quotes)
            (then
              (return
                (call $reader_failure (i32.const 3) (local.get $byte_len)))))
          (if
            (i32.eqz (ref.eq (local.get $frame) (local.get $root)))
            (then
              (return
                (call $reader_failure (i32.const 2) (local.get $byte_len)))))
          (return
            (call $reader_success
              (struct.get $reader_frame $head (local.get $root))))))
      (local.set $byte (i32.load8_u (local.get $offset)))
      (if
        (i32.eq (local.get $byte) (i32.const 0x28))
        (then
          (local.set $frame
            (struct.new $reader_frame
              (local.get $frame)
              (global.get $nil_value)
              (global.get $nil_value)
              (local.get $pending_quotes)))
          (local.set $pending_quotes (i32.const 0))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (br $read_next)))
      (if
        (i32.eq (local.get $byte) (i32.const 0x29))
        (then
          (if
            (local.get $pending_quotes)
            (then
              (return
                (call $reader_failure (i32.const 3) (local.get $offset)))))
          (if
            (ref.eq (local.get $frame) (local.get $root))
            (then
              (return
                (call $reader_failure (i32.const 1) (local.get $offset)))))
          (local.set $completed
            (call $reader_wrap_quotes
              (struct.get $reader_frame $head (local.get $frame))
              (struct.get $reader_frame $quotes (local.get $frame))))
          (local.set $parent
            (ref.cast (ref $reader_frame)
              (struct.get $reader_frame $parent (local.get $frame))))
          (local.set $frame (local.get $parent))
          (call $reader_append (local.get $frame) (local.get $completed))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (br $read_next)))
      (if
        (i32.eq (local.get $byte) (i32.const 0x27))
        (then
          (local.set $pending_quotes
            (i32.add (local.get $pending_quotes) (i32.const 1)))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (br $read_next)))
      (if
        (i32.eq (local.get $byte) (i32.const 0x22))
        (then
          (local.set $token_start (local.get $offset))
          (local.set $token_len (i32.const 0))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (block $string_done
            (loop $read_string
              (if
                (i32.ge_u (local.get $offset) (local.get $byte_len))
                (then
                  (return
                    (call $reader_failure
                      (i32.const 9)
                      (local.get $token_start)))))
              (local.set $byte (i32.load8_u (local.get $offset)))
              (if
                (i32.eq (local.get $byte) (i32.const 0x22))
                (then
                  (local.set $offset
                    (i32.add (local.get $offset) (i32.const 1)))
                  (br $string_done)))
              (if
                (i32.eq (local.get $byte) (i32.const 0x5c))
                (then
                  (local.set $escape_offset (local.get $offset))
                  (local.set $offset
                    (i32.add (local.get $offset) (i32.const 1)))
                  (if
                    (i32.ge_u (local.get $offset) (local.get $byte_len))
                    (then
                      (return
                        (call $reader_failure
                          (i32.const 10)
                          (local.get $escape_offset)))))
                  (local.set $byte (i32.load8_u (local.get $offset)))
                  (if
                    (i32.and
                      (i32.ne (local.get $byte) (i32.const 0x22))
                      (i32.ne (local.get $byte) (i32.const 0x5c)))
                    (then
                      (return
                        (call $reader_failure
                          (i32.const 10)
                          (local.get $escape_offset)))))))
              (i32.store8
                (i32.add (local.get $token_start) (local.get $token_len))
                (local.get $byte))
              (local.set $token_len
                (i32.add (local.get $token_len) (i32.const 1)))
              (local.set $offset
                (i32.add (local.get $offset) (i32.const 1)))
              (br $read_string)))
          (local.set $datum
            (call $memory_to_str
              (local.get $token_start)
              (local.get $token_len)))
          (local.set $datum
            (call $reader_wrap_quotes
              (local.get $datum)
              (local.get $pending_quotes)))
          (local.set $pending_quotes (i32.const 0))
          (call $reader_append (local.get $frame) (local.get $datum))
          (br $read_next)))
      (if
        (call $is_unsupported_reader_byte (local.get $byte))
        (then
          (return
            (call $reader_failure (i32.const 7) (local.get $offset)))))
      (local.set $token_start (local.get $offset))
      (block $token_done
        (loop $scan_token
          (br_if $token_done
            (i32.ge_u (local.get $offset) (local.get $byte_len)))
          (local.set $byte (i32.load8_u (local.get $offset)))
          (br_if $token_done
            (i32.or
              (call $is_reader_space (local.get $byte))
              (i32.or
                (i32.eq (local.get $byte) (i32.const 0x28))
                (i32.or
                  (i32.eq (local.get $byte) (i32.const 0x29))
                  (i32.or
                    (i32.eq (local.get $byte) (i32.const 0x27))
                    (call $is_unsupported_reader_byte (local.get $byte)))))))
          (local.set $offset (i32.add (local.get $offset) (i32.const 1)))
          (br $scan_token)))
      (local.set $token_len
        (i32.sub (local.get $offset) (local.get $token_start)))
      (local.set $byte (i32.load8_u (local.get $token_start)))
      (if
        (i32.eq (local.get $byte) (i32.const 0x23))
        (then
          (if
            (i32.and
              (i32.eq (local.get $token_len) (i32.const 2))
              (i32.eq
                (i32.load8_u (i32.add (local.get $token_start) (i32.const 1)))
                (i32.const 0x74)))
            (then (local.set $datum (global.get $true_value)))
            (else
              (if
                (i32.and
                  (i32.eq (local.get $token_len) (i32.const 2))
                  (i32.eq
                    (i32.load8_u (i32.add (local.get $token_start) (i32.const 1)))
                    (i32.const 0x66)))
                (then (local.set $datum (global.get $false_value)))
                (else
                  (if
                    (i32.and
                      (i32.eq (local.get $token_len) (i32.const 4))
                      (i32.and
                        (i32.eq
                          (i32.load8_u (i32.add (local.get $token_start) (i32.const 1)))
                          (i32.const 0x6e))
                        (i32.and
                          (i32.eq
                            (i32.load8_u (i32.add (local.get $token_start) (i32.const 2)))
                            (i32.const 0x69))
                          (i32.eq
                            (i32.load8_u (i32.add (local.get $token_start) (i32.const 3)))
                            (i32.const 0x6c)))))
                    (then (local.set $datum (global.get $nil_value)))
                    (else
                      (return
                        (call $reader_failure
                          (i32.const 4)
                          (local.get $token_start))))))))))
        (else
          (local.set $qualified_colon
            (call $qualified_token_colon
              (local.get $token_start)
              (local.get $token_len)))
          (if
            (i32.eq (local.get $qualified_colon) (i32.const -2))
            (then
              (return
                (call $reader_failure
                  (i32.const 8)
                  (local.get $token_start)))))
          (if
            (i32.ge_s (local.get $qualified_colon) (i32.const 0))
            (then
              (local.set $module_symbol
                (call $intern_memory
                  (local.get $token_start)
                  (local.get $qualified_colon)))
              (local.set $datum
                (call $intern_memory_module
                  (local.get $module_symbol)
                  (i32.add
                    (local.get $token_start)
                    (i32.add (local.get $qualified_colon) (i32.const 1)))
                  (i32.sub
                    (local.get $token_len)
                    (i32.add (local.get $qualified_colon) (i32.const 1)))))
              (local.set $integer_kind (i32.const -1)))
            (else
              (local.set $integer_kind
                (call $integer_token_kind
                  (local.get $token_start)
                  (local.get $token_len)))))
          (if
            (i32.and
              (i32.eq (local.get $token_len) (i32.const 1))
              (i32.eq (local.get $byte) (i32.const 0x2e)))
            (then
              (return
                (call $reader_failure
                  (i32.const 6)
                  (local.get $token_start)))))
          (if
            (i32.eq (local.get $integer_kind) (i32.const 2))
            (then
              (return
                (call $reader_failure
                  (i32.const 5)
                  (local.get $token_start)))))
          (if
            (i32.eq (local.get $integer_kind) (i32.const 1))
            (then
              (local.set $datum
                (ref.i31
                  (call $integer_token_value
                    (local.get $token_start)
                    (local.get $token_len)))))
            (else
              (if
                (i32.eq (local.get $integer_kind) (i32.const -1))
                (then)
                (else
              (local.set $datum
                (call $intern_memory
                  (local.get $token_start)
                  (local.get $token_len)))))))))
      (local.set $datum
        (call $reader_wrap_quotes
          (local.get $datum)
          (local.get $pending_quotes)))
      (local.set $pending_quotes (i32.const 0))
      (call $reader_append (local.get $frame) (local.get $datum))
      (br $read_next))
    (call $reader_failure (i32.const 7) (local.get $offset)))

  ;; Return the explicit success flag from a reader result.
  (func $reader_result_ok
    (param $result (ref $reader_result))
    (result i32)
    (struct.get_u $reader_result $ok (local.get $result)))

  ;; Return the parsed value or nil stored in a reader result.
  (func $reader_result_value
    (param $result (ref $reader_result))
    (result (ref eq))
    (struct.get $reader_result $value (local.get $result)))

  ;; Return zero after success or the stable syntax error code after failure.
  (func $reader_result_error_code
    (param $result (ref $reader_result))
    (result i32)
    (struct.get $reader_result $error_code (local.get $result)))

  ;; Return zero after success or the failing source byte offset after failure.
  (func $reader_result_error_offset
    (param $result (ref $reader_result))
    (result i32)
    (struct.get $reader_result $error_offset (local.get $result)))

  ;; Classify a non-null language value for the JavaScript reader facade.
  (func $value_kind
    (param $value (ref eq))
    (result i32)
    (if (ref.test (ref i31) (local.get $value)) (then (return (i32.const 1))))
    (if (call $is_bool (local.get $value)) (then (return (i32.const 2))))
    (if (call $is_str (local.get $value)) (then (return (i32.const 3))))
    (if (call $is_symbol (local.get $value)) (then (return (i32.const 4))))
    (if (call $is_cons (local.get $value)) (then (return (i32.const 5))))
    (if (call $is_nil (local.get $value)) (then (return (i32.const 6))))
    (if (call $is_obj (local.get $value)) (then (return (i32.const 7))))
    (i32.const 0))

  ;; Copy a symbol's UTF-8 name to staging memory offset zero and return its byte length.
  (func $symbol_name_to_memory
    (param $value (ref $symbol))
    (result i32)
    (local $name (ref $str))
    (local $byte_len i32)
    (local $index i32)
    (local.set $name (call $symbol_name (local.get $value)))
    (local.set $byte_len (array.len (local.get $name)))
    (block $copied
      (loop $copy_next
        (br_if $copied (i32.ge_u (local.get $index) (local.get $byte_len)))
        (i32.store8
          (local.get $index)
          (array.get_u $str (local.get $name) (local.get $index)))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $copy_next)))
    (local.get $byte_len))

  ;; Return the fixed value field for the base counter implementation of the virtual read method.
  (func $counter_read
    (type $counter_read_sig)
    (param $self (ref $counter))
    (result i32)
    (struct.get $counter $value (local.get $self)))

  ;; Return the inherited value plus the subclass offset for the overridden virtual read method.
  (func $offset_counter_read
    (type $counter_read_sig)
    (param $self (ref $counter))
    (result i32)
    (local $offset_self (ref $offset_counter))
    (local.set $offset_self
      (ref.cast (ref $offset_counter) (local.get $self)))
    (i32.add
      (struct.get $offset_counter $value (local.get $offset_self))
      (struct.get $offset_counter $offset (local.get $offset_self))))

  ;; Recur through the virtual countdown slot with a tail call and tail-dispatch to read when the count reaches zero.
  (func $counter_countdown
    (type $counter_countdown_sig)
    (param $self (ref $counter))
    (param $remaining i32)
    (result i32)
    (if
      (i32.le_s (local.get $remaining) (i32.const 0))
      (then
        (return_call_ref $counter_read_sig
          (local.get $self)
          (struct.get $counter_tag $read
            (struct.get $counter $tag (local.get $self))))))
    (return_call_ref $counter_countdown_sig
      (local.get $self)
      (i32.sub (local.get $remaining) (i32.const 1))
      (struct.get $counter_tag $countdown
        (struct.get $counter $tag (local.get $self)))))

  ;; Return the fixed offset field through the virtual method introduced by the subclass.
  (func $offset_counter_offset
    (type $offset_counter_offset_sig)
    (param $self (ref $offset_counter))
    (result i32)
    (struct.get $offset_counter $offset (local.get $self)))

  ;; These declarations make every immutable method reference available to descriptor initializers.
  (elem declare func
    $counter_read
    $offset_counter_read
    $counter_countdown
    $offset_counter_offset)

  ;; This immutable singleton descriptor installs the base counter method implementations.
  (global $counter_tag_value (ref $counter_tag)
    (struct.new $counter_tag
      (ref.func $counter_read)
      (ref.func $counter_countdown)))

  ;; This immutable singleton descriptor overrides read, inherits countdown, and installs the subclass method.
  (global $offset_counter_tag_value (ref $offset_counter_tag)
    (struct.new $offset_counter_tag
      (ref.func $offset_counter_read)
      (ref.func $counter_countdown)
      (ref.func $offset_counter_offset)))

  ;; Construct a base counter with its immutable class descriptor and fixed value field.
  (func $new_counter
    (param $value i32)
    (result (ref $counter))
    (struct.new $counter
      (global.get $counter_tag_value)
      (local.get $value)))

  ;; Construct an offset-counter subclass with inherited and appended fixed fields.
  (func $new_offset_counter
    (param $value i32)
    (param $offset i32)
    (result (ref $offset_counter))
    (struct.new $offset_counter
      (global.get $offset_counter_tag_value)
      (local.get $value)
      (local.get $offset)))
