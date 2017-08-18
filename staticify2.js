const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const {EventEmitter} = require('events');
const tmp = util.promisify(fs.mkdtemp)
const url = require('url');

// Third party installables
const walkdir = require('ewalkdir');
const mime = require('mime');

// some constants
const PATHS = () => [path.join(process.cwd(), 'public')]
const FileHashAgent = require('./file-hash-agent');
// RegExp for matching hashes.
// Matches base16 (hex) values for md5 (32) and whirlpool (128).
const hashPool = /\b([0-9a-f]{32}|[0-9a-f]{128})\b/g
// is a break; hex data; is end of line.
// Matches base64 (b64) values for md5 (22|24) and whirlpool (86|88).
const hashPool64 = /(?=\b|^)([0-9A-Za-z_-]{22}|[0-9A-Za-z_-]{86})$/g
// Is is a break; b64 data; is definitely end of line.


class staticify2 extends EventEmitter {
  /**
   * @constructor staticify2
   * @extends {events} eventemitter
   * @arg {array<string>|string} paths to crawl.
   * @arg {string} path to crawl (singular).
   * @arg {number} maxDepth - maximum depth to crawl to.
   * @arg {number} depth - alias for maxDepth
   * @arg {string} relTop - relationship to the top level server. Must start with /.
   * @arg {boolean} compress - compress files to tmpdir. Default true.
   * @arg {string} tmpdir - not required, sets temporary dir if required.
   * @arg {string} tempdir - alias for tmpdir
   * @arg {string|boolean} eTmpdir - exact tempdir, specifies that eTmpdir (when string) or tempdir (when boolean) is an exact directory.
   * @arg {string|boolean} eTempdir - alias for eTmpdir
   * @arg {boolean} unlinkOnExit - removes the tempdir synchronously on exit.
   * @arg {boolean} rmTmpOnExit - alias for unlinkOnExit
   * @arg {boolean} rmOnExit - alias for rmTmpOnExit
   */
  constructor({
    paths, path, maxDepth = 10, depth = maxDepth, relTop = '/', compress = true,
    tmpdir = path.join(os.tmpdir(), 'staticify2-'), tempdir = tmpdir,
    eTmpdir, eTempdir = eTmpdir,
    unlinkOnExit, rmTmpOnExit = unlinkOnExit, rmOnExit = rmTmpOnExit
  } = {}) {
    if (!(paths || path)) throw new SyntaxError(
      'path or paths argument is required',
      'STATICIFY_PATH_ARG_REQUIRED'
    );;
    super()

    this.depth = depth; // If maxDepth is set, depth === maxDepth; if depth is set, depth === depth
    this.compress = !!compress;

    if (path || paths) {
      if (Array.isArray(paths))
        this.paths = paths
      else if (typeof paths === 'string')
        this.paths = [paths]
      ;;

      if (typeof path === 'string') {
        if (this.paths) this.paths.push(path)
        else this.paths = [path]
      };;
    } else {
      this.paths = PATHS()
    }
    this.relTop = relTop;

    this.map = new Map();
    this.ucache = new Map();

    this.ready = false;
    this.mime = mime;

    this.onceTmpDirReady = new Promise((r,e) => {
      if (!compress) r(false) // no tmpdir
      if (eTempdir) {
        let stat = (dir, type) => fs.stat(dir, (err, stats) => {
          if (err && err.code !== 'ENOENT') return e(err)
          if (err) fs.mkdir(dir, err => {
            if (err) e(err)
            else this.emit('tmpdir_ready', dir)
          })
          if (stats.isDirectory()) this.emit('tmpdir_ready', dir)
          else e(`${type} (${dir}) is a string but not a directory?`)
        })
        if (typeof eTempdir === 'string') stat(eTempdir, 'eTempdir')
        else stat(tempdir, 'tempdir')
      }
      this.once('tmpdir_ready', r)
    });

    if (rmOnExit) this.onceTmpDirReady
    .then(d => d ? process.on('exit', () => fs.unlinkSync(d)) : 0)

    setImmediate(this.init.bind(this), this, tempdir, eTempdir);
  }

  /**
   * @func init
   * @static
   * @arg {undefined|string|array<string>|object} opts - options,
   */
  static init(opts) {
    if (typeof opts === 'undefined') // presume the worst
      opts = { paths: [ path.join(process.cwd(), 'public') ] }
    else if (typeof opts === 'string')
      opts = { paths: [ opts ] }
    else if (Array.isArray(opts))
      opts = { paths: opts }
    ;;

    return new staticify2(opts);
  }

  /**
   * @method init
   * @private
   * @async
   * @arg {this} self this
   * @arg {string} tempdir to use/create.
   */
  async init(self, tempdir, eTempdir) {
    walkdir({
      dirs: self.paths,
      depth: self.depth,
      emitDefault: false,
      relTop: self.relTop,
      emitFiles: true,
      followSymlinks: true
    }).on('file', ({dir: filename, stats, relTop}) => {
      let agent = new FileHashAgent({filename, stats, relTop, parent: self});;

      self.map.set(filename, agent).set(relTop, agent)

      agent.onceHashReady.then(({hex, b64}) => {
        self.map.set(hex, agent).set(b64, agent)
      })
      agent.oncePoolReady.then(({hex, b64}) => {
        self.map.set(hex, agent).set(b64, agent)
      })
    })

    if (!eTempdir || this.compress)
      self.emit('tmpdir_ready', await tmp(tempdir))
      // tmpdir is probably gonna work.
    ;;
  }

  /**
   * @method createMiddleware
   * @arg {string} prefix prefixing the URL, if you use Express this is unnecessary to set.
   * @arg {boolean} createLocals - whether to prefix the locals or not.
   * @arg {boolean} caseSensitive - dunno
   */
  createMiddleware({prefix = '/', createLocals, caseSensitive} = {}) {
    const self = this;

    return async function middleware(req, res, next) {
      if (createLocals)
        typeof res.locals === 'object'
        ? (
          res.locals.staticify
          ? null
          : res.locals.staticify = self,
          res.locals.getVersionedPath
          ? null
          : res.locals.getVersionedPath = (url) => self.getVersionedPath({
            prefix, url
          })
        ) : res.locals = {
          staticify: self,
          getVersionedPath: (url, style) => self.getVersionedPath({
            prefix, url, style
          })
        }
      ;;
    }
  }

  /** @method createServe
    * @arg {string} prefix
    */
  createServe(prefix) {
    const getVersion = this.getVersion.bind(this, prefix);
    return async function serve(req, res) {
      let v = await getVersion(req.path || req.url)
      if (v) {
        v.middleware(req, res)
      }
    }
  }

  /**
   * @method getVersionedPath
   * @arg {string} prefix
   * @arg {string} url
   */
  getVersionedPath(opts) {
    if (typeof opts === 'string')
      opts = {url: opts}
    ;;
    let v = this.getVersion(opts.prefix, opts.url)
    return v.url ? v.url(opts.prefix, opts.style) : v;
  }

  /**
   * @method getVersion
   * @arg {string} prefix
   * @arg {string|url} URL
   * @returns {FileHashAgent}
   */
  getVersion(prefix = this.relTop, URL) {
    let [,v] = URL.match(hashPool)
            || URL.match(hashPool64)
            || [URL, url.parse(URL).pathname]
    ;
    return this.map.get(v);
  }

  /**
   * @method setSourceMap
   * @arg {string} reltop
   * @arg {FileHashAgent} agent
   * @async
   */
  async setSourceMap(reltop, agent) {
    let {vURL: {md5, pool}} = await agent.onceAllReady
    let file = reltop.slice(0,-4)
    if (this.map.has(file)) this.map.get(file).trailers.set('SourceMap', pool)
    else let iter = 0, interval = setInterval(() => {
      if (this.map.has(file)) {
        clearInterval(interval)
        this.map.get(file).trailers.set('SourceMap', pool)
      } else if (iter++ > 9) clearInterval(interval);;
    }, 1e3);
  }
}

exports = module.exports = staticify2;
exports.FileHashAgent = FileHashAgent;

exports.hashPool = hashPool // base16 (hex)
exports.hashPool64 = hashPool64 // base64
