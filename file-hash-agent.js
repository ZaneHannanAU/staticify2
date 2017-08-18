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
const ZLIB_KEYS = new Set(Object.getOwnPropertyNames(zlib)),
      COMPRESSIBLE = /text|application(?!\/octet-stream)/,
      B64RE = /\+|\/|=+/g,
      exists = f => new Promise(r => fs.stat(f, (e, s) => e ? r(!e) : r(s))),
      URLB64 = buf => buf.toString('base64').replace(
        B64RE, m => m === '+' ? '-' : (m === '/' ? '_' : '')),
      createHasher = (hasher = 'md5', filename, ...writeHead) => {
        let hash = crypto.createHash(hasher)
        for (const block of writeHead) hash.write(String(block));;
        if (!filename) return hash
        let file = fs.createReadStream(filename)
        file.pipe(hash)
        return {file, hash}
      },
      NOT_ALLOWED = {Allow: ['GET', 'HEAD']},
      SERVER = {Server: `staticify2 agent ${version}`},
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
    this.compress = COMPRESSIBLE.test(mime) && parent.compress;
    // don't compress if video/image/etc

    this.path = filename;
    this.relPath = relTop;
    this.dirname = path.posix.dirname(relTop);
    this.basename = path.posix.basename(relTop, '.map');

    this.extname = path.extname(filename);
    if (this.extname === '.map')
      parent.setSourceMap(filename, this)
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
    let {file: file_md5, hash: md5sum} = createHasher('md5', this.path)
    file_md5.on('end', () => {
      const hash = md5sum.digest();
      let b64 = URLB64(hash);
      this.emit('hash_ready', {
        hash, hex: hash.toString('hex'), b64, base64: b64,
        toString: hash.toString.bind(hash, 'hex')
      })
    })

    let {file: file_whirlpool, hash: whirlpool} = createHasher(
      'md5', this.path, this.relTop, this.headers.get('Last-Modified')
    );;
    file_whirlpool.on('end', () => {
      const pool = whirlpool.digest()
      let b64 = URLB64(pool);
      this.emit('pool_ready', {
        pool, hex: pool.toString('hex'), b64, base64: b64,
        toString: pool.toString.bind(pool, 'hex')
      })
    })

    let [{b64:md64, hex:mdH}, {b64:p64, hex:pH}, tmpdir] = await Promise.all([
      this.onceHashReady, this.oncePoolReady,
      this.parent.onceTmpDirReady
    ]);
    let trailers = this.headers.get('Trailers');
    this.trailers.set('Content-MD5', md64).set('ETag', `"${p64}"`)
    if (this.compress) for (const stream of ZLIB_KEYS) {
      // zipname or something.
      let zn = path.join(tmpdir, md64 +'.'+ p64 + this.extname +'.'+ stream);
      // Something like /tmp/staticify2-itXde2/(b64<22>).(b64<86>).js.br
      if (await exists(zn)) break;;
      // Shouldn't exist but otherwise will likely break something otherwise.
      let z = zlib[stream]();
      let output = fs.createWriteStream(zn);
      // Save to a temporary directory
      let input = fs.createReadStream(this.path);
      input.on('end', () => this.files[stream] = zn)
      input.pipe(z).pipe(output);
    };;

    this.emit('all_ready', {md64, mdHex: mdH, pb64: p64, pHex: pH, vURL: {
      md5: path.join(this.dirname, this.basename + '.' + md64 + this.extname),
      pool: path.join(this.dirname, this.basename + '.' + p64 + this.extname)
    }});
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
          return await this.setTrailers(req, res)
        } else {
          res.writeHead(304, SERVER)
          return res.end()
        }
      } else if (method === 'HEAD') {
        await Promise.all([
          this.setHeaders(req, res, 204),
          this.setTrailers(req, res)
        ]);
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
  async setHeaders(req, res, satus = 200) {
    let headers = Object.create(null);
    for (const [k, v] of this.headers)
      headers[k] = typeof v !== 'function' ? v : v()
    ;;

    let encodings = new Set(accepts(req).encodings());
    headers['Content-Encoding'] = 'identity';

    for (const enc of ZLIB_KEYS) {
      if (encodings.has(enc) && this.files[enc]) {
        headers['Content-Encoding'] = enc;
        break;
      }
    }
    res.writeHead(status, headers)
    return headers;
  }

  /**
   * @method setTrailers
   * @arg {request} req
   * @arg {response} res
   * @returns {trailers}
   */
  async setTrailers(req, res) {
    let t = Object.create(null)
    for (const [k, v] of this.trailers) t[k] = typeof v !== 'function' ? v : v()
    res.addTrailers(t)
    return t;
  }
  url(prefix = '', style = 'hash') {
    return this.hashes
      ? (style === 'hash' ?  : )
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
