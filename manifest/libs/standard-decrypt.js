/*
 * standard-decrypt.js
 * ECMA-376 Standard Encryption（EncryptionInfo 版本 2.2 / 3.2 / 4.2，二进制头）解密。
 *
 * 背景：系统名单以前用 Agile（XML 头，AES-CBC），2026-11-13 起出现 Standard 版
 * （二进制头，AES-ECB + SHA1）。页面原有的 xlsx-populate 只认 Agile，遇到
 * Standard 会把二进制当 XML 解析，报「Non-whitespace before first tag」，
 * 被页面统一翻译成「密码不对」，其实密码是对的。
 *
 * 本模块全部用纯 JS 实现：CFB(OLE) 容器读取 + SHA1 + AES-ECB 解密，
 * 不依赖 WebCrypto、不依赖网络、不依赖第三方库，离线 file:// 也能用。
 * 只处理「解密」，解出来的字节交给 SheetJS 继续解析。
 *
 * 用法：
 *   OfficeStandardDecrypt.detect(arrayBufferOrUint8Array) -> 'standard' | 'agile' | 'other' | null
 *   OfficeStandardDecrypt.decrypt(arrayBufferOrUint8Array, password) -> ArrayBuffer
 *   错误对象带 code：BAD_PASSWORD / UNSUPPORTED / BAD_DATA / NOT_STANDARD
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OfficeStandardDecrypt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基础字节工具 ----------
  function asU8(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    throw new Error('需要 ArrayBuffer / Uint8Array');
  }
  function rd16(b, o) { return (b[o] | (b[o + 1] << 8)) & 0xffff; }
  function rd32(b, o) { return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0); }
  function cat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), p = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length; }
    return out;
  }
  function equal(a, b) {
    if (a.length !== b.length) return false;
    var x = 0;
    for (var i = 0; i < a.length; i++) x |= a[i] ^ b[i];
    return x === 0;
  }
  function utf16le(s) {
    var out = new Uint8Array(s.length * 2);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out[i * 2] = c & 0xff; out[i * 2 + 1] = (c >>> 8) & 0xff;
    }
    return out;
  }
  function fail(code, msg) {
    var e = new Error(msg || code);
    e.code = code;
    throw e;
  }

  // ---------- CFB / OLE 复合文档 ----------
  var OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  var ENDOFCHAIN = 0xfffffffe, FREESECT = 0xffffffff;

  function readCfb(b) {
    for (var i = 0; i < 8; i++) if (b[i] !== OLE_MAGIC[i]) return null;
    var ss = 1 << rd16(b, 30);
    var firstDir = rd32(b, 48);
    var firstMiniFat = rd32(b, 60);
    var numDifat = rd32(b, 68), firstDifat = rd32(b, 72);

    function sector(s) { return b.subarray((s + 1) * ss, (s + 1) * ss + ss); }

    // FAT 扇区清单：头部 109 项 + 扩展 DIFAT 链
    var difat = [], k;
    for (k = 0; k < 109; k++) {
      var s0 = rd32(b, 76 + 4 * k);
      if (s0 < ENDOFCHAIN) difat.push(s0);
    }
    // 扩展 DIFAT 链只在大文件才有；加自环/越界防护，避免畸形文件把页面卡死
    var ds = firstDifat, guard = 0, maxGuard = Math.min(numDifat + 2, 1024);
    while (ds < ENDOFCHAIN && guard++ < maxGuard && difat.length < 20000) {
      var sec = sector(ds);
      if (sec.length < ss) break;
      for (k = 0; k < ss / 4 - 1; k++) {
        var s1 = rd32(sec, k * 4);
        if (s1 < ENDOFCHAIN) difat.push(s1);
      }
      var next = rd32(sec, ss - 4);
      if (next >= ENDOFCHAIN || next === ds || next === FREESECT) break;
      ds = next;
    }
    var fatBuf = cat(difat.map(sector));
    var fat = new Uint32Array(fatBuf.length >> 2);
    for (k = 0; k < fat.length; k++) fat[k] = rd32(fatBuf, k * 4);

    function chain(start) {
      var out = [], cur = start, seen = {};
      while (cur < ENDOFCHAIN && cur < fat.length && !seen[cur]) {
        seen[cur] = 1; out.push(cur); cur = fat[cur];
      }
      return out;
    }
    function readFatAll(start) { return cat(chain(start).map(sector)); }

    var dir = readFatAll(firstDir), entries = [];
    for (var off = 0; off + 128 <= dir.length; off += 128) {
      var e = dir.subarray(off, off + 128);
      var nl = rd16(e, 64);
      if (!nl || nl > 64 || nl % 2) continue;
      var name = '';
      for (var j = 0; j < nl - 2; j += 2) name += String.fromCharCode(rd16(e, j));
      entries.push({ name: name, type: e[66], start: rd32(e, 116), size: rd32(e, 120) });
    }
    function find(n) {
      for (var t = 0; t < entries.length; t++) if (entries[t].name === n) return entries[t];
      return null;
    }
    function streamOf(en) {
      if (!en) return null;
      // 小于 4096 字节的流放在 mini stream 里
      if (en.size >= 4096) return readFatAll(en.start).subarray(0, en.size);
      var root = null;
      for (var t = 0; t < entries.length; t++) if (entries[t].type === 5) { root = entries[t]; break; }
      if (!root) return null;
      var mini = readFatAll(root.start).subarray(0, root.size);
      var mfatBuf = firstMiniFat < ENDOFCHAIN ? readFatAll(firstMiniFat) : new Uint8Array(0);
      var mfat = new Uint32Array(mfatBuf.length >> 2);
      for (var m = 0; m < mfat.length; m++) mfat[m] = rd32(mfatBuf, m * 4);
      var chunks = [], cur = en.start, seen = {}, guard2 = 0;
      while (cur < ENDOFCHAIN && cur < mfat.length && !seen[cur] && guard2++ < 100000) {
        seen[cur] = 1;
        chunks.push(mini.subarray(cur * 64, (cur + 1) * 64));
        cur = mfat[cur];
      }
      return cat(chunks).subarray(0, en.size);
    }
    return {
      info: streamOf(find('EncryptionInfo')),
      package: streamOf(find('EncryptedPackage'))
    };
  }

  // ---------- SHA1（同步纯 JS，5 万次迭代要够快）----------
  function sha1(msg) {
    var bitLen = msg.length * 8;
    var total = ((msg.length + 1 + 8 + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(msg, 0);
    buf[msg.length] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(total - 4, bitLen >>> 0, false);
    var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe,
        h3 = 0x10325476, h4 = 0xc3d2e1f0;
    var w = new Int32Array(80), off, i, a, b, c, d, e2, f, kk, t, n;
    for (off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
      for (i = 16; i < 80; i++) {
        n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (n << 1) | (n >>> 31);
      }
      a = h0; b = h1; c = h2; d = h3; e2 = h4;
      for (i = 0; i < 80; i++) {
        if (i < 20) { f = (b & c) | (~b & d); kk = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d; kk = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); kk = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; kk = 0xca62c1d6; }
        t = (((a << 5) | (a >>> 27)) + (f | 0) + (e2 | 0) + kk + (w[i] | 0)) | 0;
        e2 = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0; h4 = (h4 + e2) | 0;
    }
    var out = new Uint8Array(20), odv = new DataView(out.buffer);
    odv.setInt32(0, h0, false); odv.setInt32(4, h1, false); odv.setInt32(8, h2, false);
    odv.setInt32(12, h3, false); odv.setInt32(16, h4, false);
    return out;
  }

  // ---------- AES（ECB 解密，支持 128/192/256 位密钥）----------
  function gmul(a, b) {
    var p = 0, i, hi;
    for (i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>>= 1;
    }
    return p & 0xff;
  }
  var SBOX = null, INV_SBOX = null;
  function buildSbox() {
    if (SBOX) return;
    SBOX = new Uint8Array(256); INV_SBOX = new Uint8Array(256);
    var i, bit, inv, a, b, e, x, v;
    for (i = 0; i < 256; i++) {
      inv = 0;
      if (i) {                       // GF(2^8) 里的逆元：i^254
        a = i; b = 1; e = 254;
        while (e) { if (e & 1) b = gmul(b, a); a = gmul(a, a); e >>>= 1; }
        inv = b;
      }
      v = 0;                         // 仿射变换 + 0x63
      for (bit = 0; bit < 8; bit++) {
        x = ((inv >>> bit) & 1) ^ ((inv >>> ((bit + 4) & 7)) & 1)
          ^ ((inv >>> ((bit + 5) & 7)) & 1) ^ ((inv >>> ((bit + 6) & 7)) & 1)
          ^ ((inv >>> ((bit + 7) & 7)) & 1) ^ ((0x63 >>> bit) & 1);
        v |= x << bit;
      }
      SBOX[i] = v;
    }
    for (i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  }
  var RCON = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54, 108, 216, 171, 77];
  function expandKey(key) {
    var nk = key.length / 4, nr = nk + 6, words = [], i, j;
    for (i = 0; i < nk; i++) words.push(key.slice(i * 4, i * 4 + 4));
    for (i = nk; i < 4 * (nr + 1); i++) {
      var t = Uint8Array.from(words[i - 1]);
      if (i % nk === 0) {
        t = Uint8Array.from([
          SBOX[t[1]] ^ RCON[i / nk], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]
        ]);
      } else if (nk > 6 && i % nk === 4) {
        t = Uint8Array.from([SBOX[t[0]], SBOX[t[1]], SBOX[t[2]], SBOX[t[3]]]);
      }
      var prev = words[i - nk], out = new Uint8Array(4);
      for (j = 0; j < 4; j++) out[j] = prev[j] ^ t[j];
      words.push(out);
    }
    var rks = [];
    for (i = 0; i <= nr; i++) rks.push(cat([words[i * 4], words[i * 4 + 1], words[i * 4 + 2], words[i * 4 + 3]]));
    return { rks: rks, nr: nr };
  }
  function decryptBlock(src, dstOff, dst, ctx) {
    var s = new Uint8Array(16), i, c, r, tmp;
    for (i = 0; i < 16; i++) s[i] = src[i];
    function addRk(k) { for (var q = 0; q < 16; q++) s[q] ^= ctx.rks[k][q]; }
    function invShift() {
      var o = new Uint8Array(16), rr, cc;   // 必须用局部变量，别改到外层轮次 r
      for (rr = 0; rr < 4; rr++) {
        for (cc = 0; cc < 4; cc++) o[4 * cc + rr] = s[4 * ((cc + 4 - rr) & 3) + rr];
      }
      s.set(o);
    }
    function invSub() { for (var q = 0; q < 16; q++) s[q] = INV_SBOX[s[q]]; }
    function invMix() {
      var o = new Uint8Array(16), cc;
      for (cc = 0; cc < 4; cc++) {
        var p = 4 * cc;
        o[p]     = gmul(s[p], 14) ^ gmul(s[p + 1], 11) ^ gmul(s[p + 2], 13) ^ gmul(s[p + 3], 9);
        o[p + 1] = gmul(s[p], 9)  ^ gmul(s[p + 1], 14) ^ gmul(s[p + 2], 11) ^ gmul(s[p + 3], 13);
        o[p + 2] = gmul(s[p], 13) ^ gmul(s[p + 1], 9)  ^ gmul(s[p + 2], 14) ^ gmul(s[p + 3], 11);
        o[p + 3] = gmul(s[p], 11) ^ gmul(s[p + 1], 13) ^ gmul(s[p + 2], 9)  ^ gmul(s[p + 3], 14);
      }
      s.set(o);
    }
    addRk(ctx.nr);
    for (r = ctx.nr - 1; r >= 1; r--) { invShift(); invSub(); addRk(r); invMix(); }
    invShift(); invSub(); addRk(0);
    dst.set(s, dstOff);
  }
  function aesEcbDecrypt(key, data) {
    buildSbox();
    var ctx = expandKey(key), out = new Uint8Array(data.length);
    for (var off = 0; off + 16 <= data.length; off += 16) decryptBlock(data.subarray(off, off + 16), off, out, ctx);
    return out;
  }

  // ---------- 密钥派生（MS-OFFCRYPTO 2.3.7.1），带同文件缓存 ----------
  var keyCache = {};
  function deriveKey(password, salt, hashLen, keyBytes) {
    var cacheKey = '';
    for (var q = 0; q < salt.length; q++) cacheKey += String.fromCharCode(salt[q]);
    cacheKey += '\u0000' + password + '\u0000' + keyBytes;
    if (keyCache[cacheKey]) return keyCache[cacheKey];

    var h = sha1(cat([salt, utf16le(password)]));
    var ib = new Uint8Array(4), i;
    for (i = 0; i < 50000; i++) {
      ib[0] = i & 255; ib[1] = (i >>> 8) & 255; ib[2] = (i >>> 16) & 255; ib[3] = (i >>> 24) & 255;
      h = sha1(cat([ib, h]));
    }
    var zero = new Uint8Array(4);
    var hf = sha1(cat([h, zero]));
    var p1 = new Uint8Array(64), p2 = new Uint8Array(64), k;
    for (k = 0; k < 64; k++) { p1[k] = 0x36; p2[k] = 0x5c; }
    for (k = 0; k < hf.length && k < 64; k++) { p1[k] ^= hf[k]; p2[k] ^= hf[k]; }
    var key = cat([sha1(p1), sha1(p2)]).subarray(0, keyBytes);
    keyCache[cacheKey] = key;
    return key;
  }

  // ---------- 对外接口 ----------
  function detect(input) {
    try {
      var b = asU8(input), cfb = readCfb(b);
      if (!cfb || !cfb.info || cfb.info.length < 4) return null;
      var major = rd16(cfb.info, 0), minor = rd16(cfb.info, 2);
      if (major === 4 && minor === 4) return 'agile';          // 交给 xlsx-populate
      if (minor === 2 && major >= 2 && major <= 4) return 'standard';
      return 'other';
    } catch (e) { return null; }   // 认不出来就交回原来的路径，绝不让页面卡住
  }

  function decrypt(input, password) {
    var b = asU8(input), cfb;
    try { cfb = readCfb(b); }
    catch (e) { fail('BAD_DATA', '加密文件结构无法解析'); }
    if (!cfb || !cfb.info || !cfb.package) fail('NOT_STANDARD', '不是加密的 Excel 文件');
    var info = cfb.info, pkg = cfb.package;
    var major = rd16(info, 0), minor = rd16(info, 2);
    if (major === 4 && minor === 4) fail('NOT_STANDARD', '这是 Agile 加密，应走 xlsx-populate');
    if (!(minor === 2 && major >= 2 && major <= 4)) {
      fail('UNSUPPORTED', '不支持的加密版本 ' + major + '.' + minor);
    }

    var headerSize = rd32(info, 8);
    var algId = rd32(info, 20), algHash = rd32(info, 24), keyBits = rd32(info, 28);
    if (algHash !== 0x8004) fail('UNSUPPORTED', '只支持 SHA1 派生的旧版加密');
    var keyBytes;
    if (algId === 0x660e) keyBytes = 16;
    else if (algId === 0x660f) keyBytes = 24;
    else if (algId === 0x6610) keyBytes = 32;
    else fail('UNSUPPORTED', '只支持 AES 加密（这份文件用的是 0x' + algId.toString(16) + '）');
    if (keyBits && keyBits / 8 !== keyBytes) keyBytes = keyBits / 8;

    var voff = 12 + headerSize;
    if (voff + 4 + 16 + 16 + 4 > info.length) fail('BAD_DATA', '加密信息不完整');
    var saltSize = rd32(info, voff); voff += 4;
    var salt = info.subarray(voff, voff + saltSize); voff += saltSize;
    var encVerifier = info.subarray(voff, voff + 16); voff += 16;
    var vhSize = rd32(info, voff); voff += 4;
    var encVerifierHash = info.subarray(voff, voff + 32);

    var key = deriveKey(String(password == null ? '' : password), salt, 20, keyBytes);
    var verifier = aesEcbDecrypt(key, encVerifier).subarray(0, 16);
    var vhash = aesEcbDecrypt(key, encVerifierHash).subarray(0, Math.min(vhSize, 20));
    if (!equal(sha1(verifier), vhash)) fail('BAD_PASSWORD', '密码不正确');

    var total = rd32(pkg, 0);
    var enc = pkg.subarray(8);
    if (!enc.length || enc.length % 16) fail('BAD_DATA', '加密数据长度异常');
    var plain = aesEcbDecrypt(key, enc).subarray(0, total);
    if (plain.length < 4 || rd32(plain, 0) !== 0x04034b50) fail('BAD_DATA', '解密结果不是 Excel 文件');
    return plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
  }

  return {
    detect: detect, decrypt: decrypt,
    _sha1: sha1, _aesEcbDecrypt: aesEcbDecrypt,
    _buildSbox: buildSbox, _expandKey: expandKey, _gmul: gmul
  };
});
