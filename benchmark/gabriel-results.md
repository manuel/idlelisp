# Gabriel benchmark

Node v26.4.0. Each engine gets 2 warmup batches and 5 measured batches. Both engines run the same fixed iteration count for each benchmark. Compilation is excluded from execution timings.

## Execution

| Benchmark | Iterations | Idle/op | Guile/op | JavaScript/op | Idle relative | Guile relative | JavaScript relative |
|---|---:|---:|---:|---:|---:|---:|---:|
| deriv | 1024 | 1.52 us | 3.79 us | 1.51 us | 1.00 | 0.40 | 1.00 |
| diviter | 64 | 14.29 us | 11.82 us | 37.93 us | 1.00 | 1.21 | 0.38 |
| divrec | 128 | 26.73 us | 30.36 us | 11.41 us | 1.00 | 0.88 | 2.34 |
| tak | 50 | 144.55 us | 487.98 us | 401.80 us | 1.00 | 0.30 | 0.36 |
| takl | 50 | 7.420 ms | 3.126 ms | 3.858 ms | 1.00 | 2.37 | 1.92 |
| ntakl | 50 | 7.865 ms | 3.229 ms | 3.939 ms | 1.00 | 2.44 | 2.00 |
| cpstak | 8 | 378.70 us | 48.41 us | 147.33 us | 1.00 | 7.82 | 2.57 |

Assessment: Guile's median relative score is 1.21 and JavaScript's is 1.92, against Idle at 1.00. A score above 1.00 means that engine is faster than Idle; below 1.00 means it is slower.

## Compilation and setup

| Compiler | Stage | Time |
|---|---|---:|
| Idle | .idle to validated WAT | 1107.318 ms |
| Idle | Binaryen -O4 optimization + Wasm emission | 588.205 ms |
| Idle | V8 compile Wasm | 904.735 ms |
| Idle | instantiate + initialize | 555.67 us |
| Idle | prebuilt object-runtime setup | 1.416 ms |
| Guile | source to fresh .go (new process) | 763.474 ms |
| JavaScript | module load + initialization | 2.380 ms |
