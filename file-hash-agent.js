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
const ZLIB_KEYS = new Set(Object.getOwnPropertyNames(zlib));
const accepts = require('accepts');

// some constants
const DIGEST = 'hex',
      CONTENT_DIGEST = 'base64', B64RE = /\+|\/|=+/g,
      COMPRESSIBLE = /text|application(?!\/octet-stream)/,
      year = 60 * 60 * 24 * 7 * 52,
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
      SERVER = `staticify2 agent ${version}`,
      HEADERS = new Map([['Server', SERVER],
        ['Vary', 'Accept-Encoding'],
        ['Cache-Control', ['no-transform', 'public', `max-age=${year}`]]
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
    if (!path) throw new SyntaxError(
      'FileHashAgent is not usable without a filename',
      'PATH_NOT_PROVIDED'
    );
    let mime = parent.mime.lookup(filename)
    super()
    this.parent = parent;
    this.headers = setBulk(undefined, [
      ['Last-Modified', stats.mtime.toGMTString()],
      ['Content-Length', stats.size],
      ['Content-Type', mime],
      ['Content-Location', relTop],
    ]);
    this.compressible = COMPRESSIBLE.test(mime); // don't compress if video/image/etc

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

    let [tmpdir,{b64: md64, hex: mdH},{b64: p64, hex: pH}] = await Promise.all([
      this.parent.onceTmpDirReady,
      this.onceHashReady,
      this.oncePoolReady
    ]);
    this.headers.set('Content-MD5', md64).set('ETag', `"${p64}"`)
    if (this.parent.compress && this.compressible) {
      for (const stream of ZLIB_KEYS) {
        let zname = path.join(tmpdir, md64+'-'+p64+this.extname+'.'+stream);
        // Something like /tmp/staticify2-itXde2/(b64<22>)-(b64<86>).js.br
        if (await exists(zname)) break;;
        // Shouldn't exist but otherwise will likely break something otherwise.
        let z = zlib[stream]();
        let output = fs.createWriteStream(zname);
        // Save to a temporary directory
        let input = fs.createReadStream(this.path);
        input.on('end', () => this.files[stream] = zname)
        input.pipe(z).pipe(output);
      }
    }
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
          ? headers['If-None-Match'] !== this.headers.get('ETag')
          : headers['If-Modified-Since']
            ? headers['If-Modified-Since'] !== this.headers.get('Last-Modified')
            : true
        ) {
          let {['Content-Encoding']: enc} = await this.setHeaders(req, res)
          fs.createReadStream(this.files[enc]).pipe(res);
        } else {
          res.writeHead(304, {
            Server: HEADERS.get('Server')
          })
        }
      } else if (method === 'HEAD') {
        await this.setHeaders(req, res, 204)
        res.end()
      } else {
        res.writeHead(405, '', {
          Allow: ['GET', 'HEAD']
        })
        return res.end()
      }
    } catch (e) {
      res.end(null)
    }
  }

  /**
   * @method setHeaders
   * @arg {request} req
   * @arg {response} res
   * @returns {object}
   */
  async setHeaders(req, res, satus = 200) {
    let sentHeaders = Object.create(null);
    for (const [name, value] of this.headers) sentHeaders[name] = value;;

    let encodings = new Set(accepts(req).encodings());
    sentHeaders.encoding = 'identity';

    for (const enc of ZLIB_KEYS) {
      if (encodings.has(enc) && this.files[enc]) {
        sentHeaders['Content-Encoding'] = enc;
        break;
      }
    }
    res.writeHead(status, sentHeaders)
    return sentHeaders;
  }
  url(prefix = '', style = 'hash') {
    switch (style) {
      case 'hashHex':
      case 'hash16':
      case 'hash':
        return prefix
          ? path.posix.join(prefix, this.hash.mdHex)
          : this.hash.mdHex
        ;
      case 'poolHex':
      case 'pool16':
      case 'pool':
        return prefix
          ? path.posix.join(prefix, this.hash.poolHex)
          : this.hash.poolHex
        ;
      case 'hash64':
        return prefix
          ? path.posix.join(prefix, this.hash.md64)
          : this.hash.md64
        ;
      case 'pool64':
        return prefix
          ? path.posix.join(prefix, this.hash.pool64)
          : this.hash.pool64
        ;
      case 'pathHash':
        return prefix
          ? path.posix.join(prefix, this.hash.pathHash)
          : this.hash.pathHash
        ;
      case 'relPath':
      default:
        return this.relPath
    }
  }
}

exports = module.exports = FileHashAgent;
exports.SERVER = SERVER;
exports.URLB64 = URLB64;
exports.HEADERS = HEADERS;
exports.exists = exists;
