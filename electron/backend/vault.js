'use strict';

// ─── vault.js ───────────────────────────────────────────────────────────────
// Encryption at rest for the plans file. Optional, like Aventurine's database
// encryption: off by default, on with a password, and the password is never
// stored anywhere.
//
// THE RECIPE IS THE ON-DISK FORMAT. Changing any of it makes existing files
// unreadable, so a new recipe needs a new `version` and a reader for the old.
//
//   key   scrypt(password NFC, salt 16 bytes, 32 bytes, N=2^16, r=8, p=1)
//   data  AES-256-GCM(key, iv 12 random bytes, aad = the header below)
//
//   { format: 'citrine-encrypted', version: 1,
//     kdf: { name: 'scrypt', N, r, p, keyLength, salt }, cipher: 'aes-256-gcm',
//     iv, tag, data }                                  (binary fields base64)
//
// The header is authenticated as AAD, so editing it (say, lowering N) makes
// decryption fail instead of quietly weakening the file. A fresh IV is drawn
// for every write; the key is derived once per unlock and held in memory only.

const crypto = require('crypto');

const FORMAT = 'citrine-encrypted';
const VERSION = 1;
const CIPHER = 'aes-256-gcm';
const KDF = { name: 'scrypt', N: 1 << 16, r: 8, p: 1, keyLength: 32 };

// Bounds on what a file may ask for. The KDF parameters come from the file,
// and a crafted file asking for N = 2^30 would make scrypt allocate 128 GiB.
const N_MIN = 1 << 14;
const N_MAX = 1 << 18;

class VaultError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function newKdf() {
    return { ...KDF, salt: crypto.randomBytes(16).toString('base64') };
}

function deriveKey(password, kdf) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            password.normalize('NFC'),
            Buffer.from(kdf.salt, 'base64'),
            kdf.keyLength,
            { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r },
            (err, key) => (err ? reject(err) : resolve(key)),
        );
    });
}

function aad(header) {
    return Buffer.from(JSON.stringify({
        format: header.format, version: header.version, kdf: header.kdf, cipher: header.cipher,
    }));
}

/** Encrypt `plaintext` (string) into the envelope's JSON text. */
function seal(plaintext, key, kdf) {
    const header = {
        format: FORMAT, version: VERSION, cipher: CIPHER,
        kdf: { name: kdf.name, N: kdf.N, r: kdf.r, p: kdf.p, keyLength: kdf.keyLength, salt: kdf.salt },
    };
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(CIPHER, key, iv);
    c.setAAD(aad(header));
    const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return JSON.stringify({
        ...header,
        iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'),
        data: data.toString('base64'),
    });
}

/** Decrypt an envelope to its plaintext string. A wrong key and a tampered
 *  file fail the same way: GCM cannot tell them apart, and neither can we. */
function open(envelope, key) {
    const d = crypto.createDecipheriv(CIPHER, key, Buffer.from(envelope.iv, 'base64'));
    d.setAAD(aad(envelope));
    d.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    try {
        return Buffer.concat([d.update(Buffer.from(envelope.data, 'base64')), d.final()]).toString('utf8');
    } catch {
        throw new VaultError('wrong_password');
    }
}

function isEnvelope(obj) {
    return !!obj && typeof obj === 'object' && obj.format === FORMAT;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const b64Len = (s) => (typeof s === 'string' && B64_RE.test(s) ? Buffer.from(s, 'base64').length : -1);

/** Throw unless the envelope is one this version can open. Runs before any
 *  key derivation, so the KDF bounds hold before scrypt sees a parameter. */
function checkEnvelope(env) {
    const k = env.kdf;
    const ok = env.version === VERSION
        && env.cipher === CIPHER
        && k && k.name === 'scrypt'
        && Number.isInteger(k.N) && k.N >= N_MIN && k.N <= N_MAX && (k.N & (k.N - 1)) === 0
        && k.r === 8 && k.p === 1 && k.keyLength === 32
        && b64Len(k.salt) >= 16
        && b64Len(env.iv) === 12
        && b64Len(env.tag) === 16
        && b64Len(env.data) >= 0;
    if (!ok) throw new VaultError(env.version > VERSION ? 'too_new' : 'unreadable');
}

module.exports = { FORMAT, VaultError, newKdf, deriveKey, seal, open, isEnvelope, checkEnvelope };
