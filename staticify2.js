const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {EventEmitter} = require('events');
const util = require('util');
const walkdir = require('ewalkdir');
const mime = require('mime');
const zlib = {
  br: require('iltorb').compressStream,
  gz: require('zlib').createGzip,
  deflate: require('zlib').createDeflate
};
const accepts = require('accepts');

const tmp = util.promisify(fs.mkdtemp)

const HASHER = 'md5',
      DIGEST = 'hex',
      CONTENT_DIGEST = 'base64',
      PATH = path.join(process.cwd(), 'public'),
      getVersionedPath = Symbol.for('getVersionedPath')
// some constants to allow easier use.

class FileHashAgent extends EventEmitter {
  /**
   * @constructor FileHashAgent
   * @extends {events} eventemitter
   * @arg {string} path to a file to hash its contents or use.
   * @arg {string} hasher to use to hash the file.
   * @arg {string} digest to consume the hash.
   */
  constructor({filename, relPath, tmpdir}) {
    if (!path) throw new SyntaxError(
      'FileHashAgent is not usable without a path',
      'PATH_NOT_PROVIDED'
    );
    super()
    this.path = filename;
    this.relPath = relPath;
    this.basename = path.basename(filename);
    this.extname = path.extname(filename);

    this.tmpdir = tmpdir;
    this.files = {
      gz: null,
      br: null,
      deflate: null
    };
    setImmediate(this.init)
  }
  async init() {
    let hashing = crypto.createHash(HASHER);
    let file = fs.createReadStream(this.path);
    file.on('end', () => {
      const hash = hashing.digest();
      this.HEX_DIGEST = hash.toString('hex');
      this.B64_DIGEST = hash.toString('base64');
      this.emit('hashready', {
        hash, hex: this.HEX_DIGEST, base64: this.B64_DIGEST
      });
    });
    file.pipe(hashing);

    this.on('hashready', ({hex}) => {
      for (const stream of await Object.getOwnPropertyNames(zlib)) {
        let name = path.join(
          this.tmpdir, hex + this.extname + stream
        );
        let z = zlib[stream]();
        let output = fs.createWriteStream(name);
        let input = fs.createReadStream(this.path);
        input.on('end', () => this.files[stream] = name)
        input.pipe(z).pipe(output);
      }
    })
  }
  async middleware(req, res) {
    if (this.hasher && this.hash)
      res.setHeader('Content-MD5', this.B64_DIGEST)
    ;;

    let encodings = new Set(await accepts(req).encodings());

    if (encodings.has('br') && this.files.br) {
      res.setHeader('Content-Encoding', 'br');
      return fs.createReadStream(this.files.br).pipe(res);
    } else if (
      (encodings.has('gzip') || encodings.has('gz'))
      && this.files.gz
    ) {
      res.setHeader('Content-Encoding', 'gzip');
      return fs.createReadStream(this.files.gz).pipe(res);
    } else {
      return fs.createReadStream(this.path).pipe(res);
    };
  }
  url(prefix = '') {
    return prefix
    ? path.posix.join(prefix, this.hash || this.relPath)
    : this.hash || this.relPath
  }
}

class staticify2 extends EventEmitter {
  /**
   * @constructor staticify2
   * @extends {events} eventemitter
   * @arg {array<string>|string} paths to crawl.
   * @arg {string} path to crawl (singular).
   * @arg {string} hasher to use to hash files.
   * @arg {number} depth - maximum depth to crawl to.
   * @arg {number} maxDepth - alias for depth
   */
  constructor({
    paths, path, maxDepth = 10, depth = maxDepth
  } = {}) {
    if (!(paths || path)) throw new SyntaxError(
      'path or paths argument is required',
      'STATICIFY_PATH_ARG_REQUIRED'
    );;
    super()

    this.hasher = HASHER; // force hasher to be MD5
    this.depth = depth; // If maxDepth is set, depth === maxDepth; if depth is set, depth === depth

    if (Array.isArray(paths))
      this.paths = paths
    else if (typeof paths === 'string')
      this.paths = [paths]
    ;

    if (typeof path === 'string') {
      if (this.paths) this.paths.push(path)
      else this.paths = [path]
    };;
    this.map = new Map;
    this.ready = false;
    setImmediate(this.init)
  }

  /**
   * @func init
   * @static
   * @arg {undefined|string|array|object} opts - options,
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
   */
  async init() {
    let tmpdir = this.tmpdir = await tmp(path.join(os.tmpdir(), 'staticify2-'));
    this.emit('ready_tmpdir', tmpdir);
    const walker = new walkdir({
      dirs: this.paths,
      depth: this.depth,
      emitDirs: false
    });
    walker.on('file', ({path, stats}) => {
      let agent = new FileHashAgent({path, tmpdir})
      .on('hashready', ({hex, base64}) => setImmediate(() => {
        this.map.set(hex, agent).set(base64, agent)
      }))
      this.map.set(path, agent)
    })
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
          getVersionedPath: (url) => self.getVersionedPath({
            prefix, url
          })
        }
      ;;
    }
  }

  /** @method createServe
    * @arg {string} prefix
    */
  createServe(prefix) {
    const self = this;
    return async function serve(req, res) {
      const version = await self.getVersion(prefix, req.path || req.url)
      return version.middleware(req, res);
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
    return this[getVersionedPath](opts)
  }
  [getVersionedPath]({prefix = '/', url, base}) {
    return this.getVersion(prefix, url).url(prefix);
  }
  getVersion(prefix, url) {
    let rel = String(url).replace(prefix, '')
    if (this.map.has(rel))
      return this.map.get(rel)
    ;
    return null;
  }
}
