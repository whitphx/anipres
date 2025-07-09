# slidev-addon-anipres

When you encounter an error like the following, run `pnpm cn-font-split i default` to fix it.
Ref: https://github.com/KonghaYao/cn-font-split/issues/164

```
[Failure [ERR_FFI]: Failed to load shared library: dlopen(/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib, 0x0006): tried: '/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib' (no such file), '/System/Volumes/Preboot/Cryptexes/OS/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib' (no such file), '/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib' (no such file)] {
  code: 'ERR_FFI',
  info: {
    lib: '/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib',
    symbol: 'font_split'
  },
  [cause]: Error: Failed to load shared library: dlopen(/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib, 0x0006): tried: '/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib' (no such file), '/System/Volumes/Preboot/Cryptexes/OS/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib' (no such file), '/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/libffi-aarch64-apple-darwin.dylib' (no such file)
      at obj.load (/workspace/node_modules/.pnpm/koffi@2.10.1/node_modules/koffi/index.js:480:27)
      at attempt (/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/node_modules/.pnpm/@xan105_error@1.7.1/node_modules/@xan105/error/lib/attempt.js:16:47)
      at /workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/node_modules/.pnpm/@xan105_error@1.7.1/node_modules/@xan105/error/lib/attempt.js:44:12
      at load (/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/node_modules/.pnpm/@xan105_ffi@1.3.0_koffi@2.10.0/node_modules/@xan105/ffi/lib/koffi/open.js:59:54)
      at Module.dlopen (/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/node_modules/.pnpm/@xan105_ffi@1.3.0_koffi@2.10.0/node_modules/@xan105/ffi/lib/koffi/open.js:104:18)
      at Module.<anonymous> (/workspace/node_modules/.pnpm/cn-font-split@7.2.2/node_modules/cn-font-split/dist/node/index.js:26:20)
      at Module._compile (node:internal/modules/cjs/loader:1730:14)
      at Object..js (node:internal/modules/cjs/loader:1895:10)
      at Module.load (node:internal/modules/cjs/loader:1465:32)
      at Function._load (node:internal/modules/cjs/loader:1282:12)
}
```
