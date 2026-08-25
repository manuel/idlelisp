export function idleWasmFeatures(binaryen) {
  return binaryen.Features.GC
    | binaryen.Features.ReferenceTypes
    | binaryen.Features.ExtendedConst
    | binaryen.Features.TailCall
    | binaryen.Features.Multivalue
    | binaryen.Features.ExceptionHandling;
}
