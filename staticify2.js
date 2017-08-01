const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {EventEmitter} = require('events');
const util = require('util');
const walkdir = require('./walkdir');

const tmp = util.promisify(fs.mkdtemp)

const HASHER = 'md5',
      DIGEST = 'hex',
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
  constructor({path, hasher = HASHER, digest = DIGEST, tmpdir}) {
    if (!path) throw new SyntaxError(
      'FileHashAgent is not usable without a path',
      'PATH_NOT_PROVIDED'
    );
    super()
    this.path = path;
    this.hasher = hasher;
    this.digest = digest;
    this.tmpdir = tmpdir;
    this.hash = undefined;
    setImmediate(this.init)
  }
  async init() {
    let hashing = crypto.createHash(this.hasher);
    let file = fs.createReadStream(this.path);
    file.on('end', () => {
      this.hash = hashing.digest(this.digest);
      this.emit('hashready', this.hash);
    });
    file.pipe(hashing)
  }
  middleware(req, res) {
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
    paths, path, hasher = HASHER, digest = DIGEST,
    maxDepth = 10, depth = maxDepth
  } = {}) {
    if (!(paths || path)) throw new SyntaxError(
      'path or paths argument is required',
      'STATICIFY_PATH_ARG_REQUIRED'
    );;
    super()

    this.hasher = hasher;
    this.digest = digest; // always use hex digests for hashes.
    this.depth = depth; //

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
    walker.on('file', (path, stats) => {
      let agent = new FileHashAgent({
        path, tmpdir, hasher: this.hasher, digest: this.digest
      }).on('hashready', (hash) => {
        this.map.set(hash, agent)
      })
      this.map.set(path, agent)
    })
  }

  /**
   * @method createMiddleware
   * @arg {regex} prefix prefixing the URL, if you use Express this is unnecessary to set.
   * @arg {boolean} createLocals - whether to prefix the locals or not.
   */
  createMiddleware({prefix = /^\//g, createLocals, caseSensitive} = {}) {
    const self = this;
    const getAgent = (agent) => self.map.get(agent);
    const hasAgent = (agent) => self.map.has(agent);

    if (typeof prefix === 'string')
      prefix = new RegExp(`^${prefix}`, caseSensitive ? 'g' : 'ig')
    ;;

    return async function middleware(req, res, next) {
      if (createLocals)
        typeof res.locals === 'object'
        ? res.locals.staticify = staticify
        : res.locals = {
          staticify: self,
          getVersionedPath: (url) => self.getVersionedPath({
            prefix, base: req.baseUrl, url
          })
        }
      ;;


    }
  }

  /**
   * @method getVersionedPath
   * @arg {regex} prefix
   * @arg {string} url
   */
  getVersionedPath(opts) {
    if (typeof opts === 'string')
      opts = {url: opts}
    ;;
    if (typeof opts.prefix === 'string')
      opts.prefix = new RegExp('^'+opts.prefix, 'g')
    ;;
    return this[getVersionedPath](opts)
  }
  [getVersionedPath]({prefix = /^\//, url}) {
    return this.getVersion(prefix, url).url;
  }
  getVersion(prefix, url) {
    let rel = String(url).replace(prefix, '')
    if (this.map.has(rel))
      return this.map.get(rel)
    ;
    return null;
  }
}
