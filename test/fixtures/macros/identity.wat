(module
  (import "idle" "car" (func $car (param (ref eq)) (result (ref eq))))
  (import "idle" "cdr" (func $cdr (param (ref eq)) (result (ref eq))))

  ;; Return the sole argument, allowing tests to prove that user WAT macros
  ;; participate in class compilation before the final WAT is emitted.
  (func $identity (export "macro:identity")
    (param $form (ref eq)) (result (ref eq))
    (call $car (call $cdr (local.get $form)))))
