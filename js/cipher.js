/*
 * Ucomms cipher — simple XOR stream cipher keyed by a 6-digit code
 * where each digit is 0–5 (a base-6 number, 46656 possible keys).
 *
 * This is a lightweight obfuscation cipher, not strong cryptography.
 * Both sender and receiver must share the same code.
 */

const Cipher = ( function () {

    const CODE_RE = /^[0-5]{6}$/;

    function isValidCode( code ) {
        return CODE_RE.test( code );
    }

    /* Interpret the 6 digits as a base-6 integer seed. */
    function seedFromCode( code ) {
        let seed = 0;
        for ( let i = 0; i < code.length; i++ ) {
            seed = seed * 6 + ( code.charCodeAt( i ) - 48 );
        }
        return seed >>> 0;
    }

    /* Small deterministic PRNG (mulberry32 variant) producing one byte per call. */
    function makeKeystream( seed ) {
        let s = ( seed ^ 0x9e3779b9 ) >>> 0;
        return function () {
            s = ( s + 0x6d2b79f5 ) >>> 0;
            let t = s;
            t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
            t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
            return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) & 0xff;
        };
    }

    /* XOR is symmetric: the same call encrypts and decrypts. */
    function apply( bytes, code ) {
        const next = makeKeystream( seedFromCode( code ) );
        const out = new Uint8Array( bytes.length );
        for ( let i = 0; i < bytes.length; i++ ) {
            out[ i ] = bytes[ i ] ^ next();
        }
        return out;
    }

    return {
        isValidCode: isValidCode,
        encrypt: apply,
        decrypt: apply
    };

} )();
