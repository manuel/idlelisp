(module
  ;; Expand the complete set of source files into one standalone WAT module.
  (import "idle" "classes_module"
    (func $module (param (ref eq)) (result (ref eq))))
  ;; Lower an ordinary virtual method call through its introduced dispatcher.
  (import "idle" "classes_call"
    (func $call (param (ref eq)) (result (ref eq))))
  ;; Lower a virtual method call that returns directly from its caller.
  (import "idle" "classes_return_call"
    (func $return_call (param (ref eq)) (result (ref eq))))
  ;; Lower a direct call to the nearest superclass implementation.
  (import "idle" "classes_super_call"
    (func $super_call (param (ref eq)) (result (ref eq))))
  ;; Lower a read from a named fixed-layout instance field.
  (import "idle" "classes_get"
    (func $get (param (ref eq)) (result (ref eq))))
  ;; Lower a write to a named mutable fixed-layout instance field.
  (import "idle" "classes_set"
    (func $set (param (ref eq)) (result (ref eq))))

  (export "macro:module" (func $module))
  (export "macro:call" (func $call))
  (export "macro:return-call" (func $return_call))
  (export "macro:super-call" (func $super_call))
  (export "macro:get" (func $get))
  (export "macro:set" (func $set)))
