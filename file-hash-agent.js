const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {EventEmitter} = require('events');
const {version} = require('./package.json');
// third party and stuff.
const zlib = {
  br: require('iltorb').compressStream,
  gzip: require('zlib').createGzip,
  deflate: require('zlib').createDeflate
};
const accepts = require('accepts');

// some constants
const COMPRESSIBLE = /xml|\btext\b|application(?!\/octet-stream)/,
      // image/svg+xml, text/*, application not octet-stream.
      exists = f => new Promise(r => fs.stat(f, (e, s) => e ? r(!e) : r(s))),
      // resolves to a truthy value with stats just in case.
      B64RE = /\+|\/|=+/g,
      // base64 RegExp replacer.
      URLB64 = buf => buf.toString('base64').replace(
        B64RE, m => m === '+' ? '-' : (m === '/' ? '_' : '')),
      // URL base64 encoder.
      createHasher = (hasher = 'md5', filename, ...writeHead) => {
        let hash = crypto.createHash(hasher)
        for (const block of writeHead) hash.write(block);;
        if (!filename) return hash
        return fs.createReadStream(filename).pipe(hash)
      },
      // hashing.
      // Static stuff.
      NOT_ALLOWED = {Allow: ['GET', 'HEAD']},
      SERVER = {Server: `staticify2 agent ${version}`},
      ZLIB_KEYS = new Set(Object.getOwnPropertyNames(zlib)),
      HEADERS = new Map([
        ['Server', SERVER.Server],
        ['Vary', 'Accept-Encoding'],
        ['Cache-Control', ['no-transform', 'public', `max-age=${3600*365.25}`]]
      ]);

const setBulk = (map = new Map(HEADERS), iter = []) => {
  for (const [k, v] of iter) map.set(k, v)
  return map;
}

class FileHashAgent extends EventEmitter {
  /**
   * @constructor FileHashAgent
   * @extends {events} eventemitter
   * @arg {string} filename to hash its contents or use.
   * @arg {fs.Stats as object} stats
   * @arg {string} relPath of the file
   * @arg {staticify2} parent of the agent.
   */
  constructor({filename, stats, relTop, parent}) {
    if (!filename) throw new SyntaxError(
      'FileHashAgent is not usable without a filename',
      'PATH_NOT_PROVIDED'
    );
    let mime = parent.mime.lookup(filename)
    super()
    this.parent = parent;
    this.trailers = new Map([
      ['Content-Location', relTop],
      ['Expires', () => new Date(Date.now() + 36e5*24*365.25).toGMTString()]
    ]);
    this.headers = setBulk(new Map(HEADERS), [
      ['Last-Modified', stats.mtime.toGMTString()],
      ['Content-Length', stats.size],
      ['Content-Type', mime],
      ['Trailer', () => [...this.trailers.keys()]]
    ]);
    this.compress = parent.compress && COMPRESSIBLE.test(mime);
    // don't compress if video/image/etc

    this.path = filename;
    this.relPath = relTop;
    this.dir = path.posix.dirname(relTop);
    this.base = path.posix.basename(relTop, '.map');

    this.ext = path.extname(filename);
    if (this.ext === '.map')
      setImmediate(parent.setSourceMap.bind(parent, filename, this))
    ;;

    this.files = {identity: this.path};

    this.onceHashReady = new Promise(r => this.once('hash_ready', r));
    this.oncePoolReady = new Promise(r => this.once('pool_ready', r));
    this.onceAllReady = new Promise(r => this.once('all_ready', r));

    setImmediate(this.init.bind(this))
  }

  /**
   * @method init
   * @async
   * @private
   */
  async init() {
    let md5 = createHasher('md5', this.path)
    .on('readable', (hash = md5.read()) => !h ? 0 : this.emit('hash_ready', {
      toString: (s = 'hex') => hash.toString(s), hex: hash.toString('hex'),
      base64: hash.toString('base64'), b64: URLB64(hash)
    }));;

    let whirl = createHasher('whirlpool', this.path, this.relTop)
    .on('readable', (pool = whirl.read()) => !h ? 0 : this.emit('pool_ready', {
      toString: (s = 'hex') => pool.toString(s), hex: pool.toString('hex'),
      base64: pool.toString('base64'), b64: URLB64(pool)
    }));;

    let [{b64:md64, hex:mdH}, {b64:p64, hex:pH}, tmpdir] = await Promise.all([
      this.onceHashReady, this.oncePoolReady,
      this.parent.onceTmpDirReady
    ]);

    this.trailers.set('Content-MD5', md64).set('ETag', `"${p64}"`)

    if (this.compress) for (const stream of ZLIB_KEYS) {
      // zipname or something.
      let zn = path.join(tmpdir, md64 +'.'+ p64 + this.ext +'.'+ stream);
      // Something like /tmp/staticify2-itXde2/(b64<22>).(b64<86>).js.br
      if (await exists(zn)) {
        // Shouldn't exist but very likely the exact same.
        this.files[stream] = zn;
        continue;
      }
      let z = zlib[stream]();
      let output = fs.createWriteStream(zn);
      // Save to a temporary directory
      let input = fs.createReadStream(this.path);
      input.on('end', () => this.files[stream] = zn)
      input.pipe(z).pipe(output);
    };;

    this.emit('all_ready', this.hashes = {md64, mdH, p64, pH, vURL: {
      md5: path.posix.join(this.dir, this.base + '.' + md64 + this.ext),
      pool: path.posix.join(this.dir, this.base + '.' + p64 + this.ext),
      smart: path.posix.join(this.parent.relTop, p64 + '.' + md64 + this.ext)
    }});
  }

  /**
   * @method http2push
   * @arg {request} req
   * @arg {response} res
   * @arg {string} style
   */
  async http2push(req, res, style = 'smart') {
    let {vURL: {[style]: URL}} = await this.onceAllReady
    res.createPushResponse({':path': URL}, ps => {
      let headers = this.createHeaders(req);
      ps.respondWithFile(this.files[headers['Content-Encoding']], headers, {
        getTrailers: this.createTrailers,
        statCheck(stat, headers) {
        }
      })
    })
  }

  /**
   * @method middleware
   * @async
   * @arg {request} req
   * @arg {response} res
   */
  async middleware(req, res) {
    try {
      let {method, headers} = req;
      if (!method || method === 'GET') {
        if (headers['If-None-Match']
          ? headers['If-None-Match'] !== this.trailers.get('ETag')
          : headers['If-Modified-Since']
            ? headers['If-Modified-Since'] !== this.headers.get('Last-Modified')
            : true
        ) {
          let {['Content-Encoding']: enc} = await this.setHeaders(req, res)
          fs.createReadStream(this.files[enc]).pipe(res);
          return this.setTrailers(req, res)
        } else {
          res.writeHead(304, SERVER)
          return res.end()
        }
      } else if (method === 'HEAD') {
        this.setHeaders(req, res, 204)
        this.setTrailers(req, res)
        return res.end()
      } else {
        res.writeHead(405, `Method ${method} Not Allowed`, NOT_ALLOWED)
        return res.end()
      }
    } catch (e) {
      return res.end(null)
    }
  }

  /**
   * @method setHeaders
   * @arg {request} req
   * @arg {response} res
   * @returns {headers}
   */
  setHeaders(req, res, satus = 200) {
    let headers = this.createHeaders(req)
    res.writeHead(status, headers)
    return headers;
  }
  createHeaders(req, headers = Object.create(null)) {
    for (const [k, v] of this.headers)
      headers[k] = typeof v !== 'function' ? v : v()
    ;;

    let encodings = new Set(accepts(req).encodings());
    headers['Content-Encoding'] = 'identity';

    for (const enc of ZLIB_KEYS) {
      if (this.files[enc] && encodings.has(enc)) {
        headers['Content-Encoding'] = enc;
        break;
      }
    }
    return headers;
  }

  /**
   * @method setTrailers
   * @arg {request} req
   * @arg {response} res
   * @returns {trailers}
   */
  setTrailers(req, res) {
    let trailers = this.createTrailers();
    res.addTrailers(trailers)
    return trailers;
  }
  createTrailers(t = Object.create(null)) {
    for (const [k, v] of this.trailers) t[k] = typeof v !== 'function' ? v : v()
    return t;
  }
  url(style = 'md5') {
    return this.hashes
      ? this.hashes.vURL[style]
      : false
  }
}

// Main
exports = module.exports = FileHashAgent;

// Constants
exports.B64RE = B64RE;
exports.SERVER = SERVER;
exports.HEADERS = HEADERS;
exports.ZLIB_KEYS = ZLIB_KEYS;

// Functions
exports.zlib = zlib;
exports.URLB64 = URLB64;
exports.exists = exists;
exports.setBulk = setBulk;
