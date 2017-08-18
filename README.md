# staticify2

Staticify with br, gz and deflate stratagems; additional headers on init and prefixes by default.

## Options


### via init

staticify2 (as `staticify2.init(opts)`) accepts the following argument types:

* `opts` {`undefined|string|array<string>|object`}: constructs staticify2 with:
  * `undefined`: `{paths: [path.join(process.cwd(), 'public')]}`. Not recommended. See [via constructor](#via-constructor).
  * `string`: `{paths: [opts]}`. See [via constructor](#via-constructor).
  * `array<string>`: `{paths: opts}`. See [via constructor](#via-constructor).
  * `object`: `opts`. See [via constructor](#via-constructor).

### via constructor

staticify2 (as `new staticify2({...opts})`) accepts the following options:

* `path` {`string`} `paths` {`array<string>|string`}: Paths to crawl. If both are `false`y values (`0`, `null`, `''`, `undefined`, `false` etc) defaults to `[path.join(process.cwd(), 'public')]`.
* `relTop` {`string` default `'/'`}: \*nix-like top level directory as path. Simplifies HTTP management. Must start with a `/`.
* `compress` {`boolean` default `true`}: Compress files to `tmpdir`/`eTmpdir`. Disabling will cause the file to always be served uncompressed as opposed to only if bad (not application or text) or etc.
* `maxDepth` {`number` default `10`} `depth` {`number` default `maxDepth`}: Depth to crawl to. Excludes `node_modules` and files beginning with `.`.
* `tmpdir` {`string` default `path.join(os.tmpdir(), 'staticify2-')`} `tempdir` {`string` default `tmpdir`}: Random six-character postfix applied, [see fs.mkdtemp](https://nodejs.org/docs/latest/api/fs.html#fs_fs_mkdtemp_prefix_options_callback) for info.
* `eTmpdir` {`boolean`}: Specifies that the temporary directory is an exact and must be used.
* `unlinkOnExit` {`boolean`} `rmTmpOnExit` {`boolean` default `unlinkOnExit`} `rmOnExit` {`boolean` default `rmTmpOnExit`}: removes the tempdir synchronously on exit if truthy (`true`, `!0`, `'non-empty string'` etc), or leaves to collection if falsy.

FileHashAgent (as `new FileHashAgent({...opts})`) takes the following options:

* `filename` {`string`}: Full path to the file.
* `stats` {`fs.Stats as object`}: File stats, include size, mtime etc.
* `relPath` {`string`}: \*nix-like top level directory of the file, used to serve.
* `parent` {`staticify2`}: Instance of staticify2 or an object implementing the same names.
