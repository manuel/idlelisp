(module
  ;; Expand the complete set of source files into one standalone WAT module.
  (import "idle" "classes_module"
    (func $module (param (ref eq)) (result (ref eq))))
  ;; Lower a read from a named fixed-layout instance field.
  (import "idle" "classes_get"
    (func $get (param (ref eq)) (result (ref eq))))
  ;; Lower a write to a named mutable fixed-layout instance field.
  (import "idle" "classes_set"
    (func $set (param (ref eq)) (result (ref eq))))

  (export "macro:module" (func $module))
  (export "macro:get" (func $get))
  (export "macro:set" (func $set)))
