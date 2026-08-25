(module
  (import "idle" "integer" (func $integer (param i32) (result (ref eq))))

  (func (export "macro:wrap") (param $form (ref eq)) (result (ref eq))
    (drop (local.get $form))
    (call $integer (i32.const 99))))
