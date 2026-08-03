/*
 * Ucomms codec — acoustic FSK modem over Web Audio.
 *
 * Tone layout per profile (19 tones, STEP Hz apart, from base):
 *   id 0        START marker
 *   id 1        GAP (separator between data symbols)
 *   id 2..17    data nibbles 0x0..0xF
 *   id 18       END marker
 *
 * Frames (first byte is the frame type):
 *   data  [ TYPE_DATA ] [ encFlag<<7 | length ] [ msgId ] [ payload ] [ checksum ]
 *   ack   [ TYPE_ACK ] [ msgId ] [ deviceId ] [ checksum ]
 * The data checksum is msgId XOR all plaintext payload bytes, so a wrong
 * decryption code is caught the same way a transmission error is. Acks
 * are always plaintext: a receiver that successfully decodes a data frame
 * replies with an ack naming the message and its own device id, letting
 * the sender count how many devices received the message.
 *
 * Each data nibble is transmitted as its tone followed by a GAP tone,
 * which makes repeated identical nibbles unambiguous for the receiver.
 */

const Codec = ( function () {

    const STEP = 120;           /* Hz between adjacent tones */
    const TONE_TOL = 55;        /* Hz tolerance when classifying a peak */
    const START_MS = 400;
    const END_MS = 400;
    const SYMBOL_MS = 90;
    const GAP_MS = 60;
    const FFT_SIZE = 2048;
    const POLL_MS = 15;
    const MAX_PAYLOAD = 127;    /* length field is 7 bits */

    const TYPE_DATA = 0x01;
    const TYPE_ACK = 0x02;

    const TONE_START = 0;
    const TONE_GAP = 1;
    const TONE_DATA0 = 2;
    const TONE_END = 18;
    const TONE_COUNT = 19;

    const PROFILES = {
        audible: {
            id: 'audible',
            label: 'Audible',
            base: 1000,
            volume: 0.5,
            hint: 'Clearly hearable tones (1.0–3.2 kHz). Most robust.'
        },
        ultrasonic: {
            id: 'ultrasonic',
            label: 'Ultrasonic',
            base: 16400,
            volume: 1.0,
            hint: 'Near-ultrasonic (16.4–18.6 kHz). Faint to some ears, inaudible to most adults.'
        },
        silent: {
            id: 'silent',
            label: 'Silent',
            base: 18800,
            volume: 1.0,
            hint: 'Fully silent (18.8–21.0 kHz). Inaudible; needs decent speakers and mic.'
        }
    };

    function freqFor( profile, toneId ) {
        return profile.base + toneId * STEP;
    }

    function bandRange( profile ) {
        return {
            lo: profile.base - 150,
            hi: freqFor( profile, TONE_COUNT - 1 ) + 150
        };
    }

    /* ------------------------------------------------------------------ */
    /* Framing                                                            */
    /* ------------------------------------------------------------------ */

    function buildFrame( text, encCode, msgId ) {
        const plain = new TextEncoder().encode( text );
        if ( plain.length === 0 || plain.length > MAX_PAYLOAD ) {
            throw new Error( 'Message must be 1–' + MAX_PAYLOAD + ' bytes (yours: ' + plain.length + ')' );
        }
        let checksum = msgId & 0xff;
        for ( let i = 0; i < plain.length; i++ ) {
            checksum ^= plain[ i ];
        }
        const payload = encCode ? Cipher.encrypt( plain, encCode ) : plain;
        const frame = new Uint8Array( plain.length + 4 );
        frame[ 0 ] = TYPE_DATA;
        frame[ 1 ] = ( encCode ? 0x80 : 0 ) | plain.length;
        frame[ 2 ] = msgId & 0xff;
        frame.set( payload, 3 );
        frame[ frame.length - 1 ] = checksum;
        return frame;
    }

    function buildAckFrame( msgId, deviceId ) {
        return new Uint8Array( [
            TYPE_ACK,
            msgId & 0xff,
            deviceId & 0xff,
            ( msgId ^ deviceId ^ 0x5a ) & 0xff
        ] );
    }

    function parseFrame( bytes, encCode ) {
        if ( bytes.length < 4 ) {
            return { ok: false, reason: 'Frame too short' };
        }
        if ( bytes[ 0 ] === TYPE_ACK ) {
            if ( bytes.length !== 4 || bytes[ 3 ] !== ( ( bytes[ 1 ] ^ bytes[ 2 ] ^ 0x5a ) & 0xff ) ) {
                return { ok: false, reason: 'Corrupt ack frame', kind: 'ack' };
            }
            return { ok: true, kind: 'ack', msgId: bytes[ 1 ], deviceId: bytes[ 2 ] };
        }
        if ( bytes[ 0 ] !== TYPE_DATA ) {
            return { ok: false, reason: 'Unknown frame type' };
        }
        const encrypted = ( bytes[ 1 ] & 0x80 ) !== 0;
        const length = bytes[ 1 ] & 0x7f;
        const msgId = bytes[ 2 ];
        if ( bytes.length !== length + 4 ) {
            return { ok: false, reason: 'Length mismatch (lost symbols)', kind: 'data' };
        }
        let payload = bytes.slice( 3, 3 + length );
        if ( encrypted ) {
            if ( !encCode ) {
                return { ok: false, reason: 'Encrypted message received — set the shared code', kind: 'data', encrypted: true };
            }
            payload = Cipher.decrypt( payload, encCode );
        }
        let checksum = msgId;
        for ( let i = 0; i < payload.length; i++ ) {
            checksum ^= payload[ i ];
        }
        if ( checksum !== bytes[ bytes.length - 1 ] ) {
            return {
                ok: false,
                reason: encrypted ? 'Checksum failed — wrong code or noisy audio' : 'Checksum failed — noisy audio',
                kind: 'data',
                encrypted: encrypted
            };
        }
        let text;
        try {
            text = new TextDecoder( 'utf-8', { fatal: true } ).decode( payload );
        } catch ( e ) {
            return { ok: false, reason: 'Corrupt text payload', kind: 'data', encrypted: encrypted };
        }
        return { ok: true, kind: 'data', text: text, msgId: msgId, encrypted: encrypted };
    }

    /* ------------------------------------------------------------------ */
    /* Transmitter                                                        */
    /* ------------------------------------------------------------------ */

    /*
     * Schedules the whole frame on an oscillator. Returns a promise that
     * resolves when playback finishes. The provided analyser (optional)
     * is inserted before the destination so the visualizer can watch.
     */
    function send( ctx, profile, frame, analyser ) {
        const nibbles = [];
        for ( let i = 0; i < frame.length; i++ ) {
            nibbles.push( ( frame[ i ] >> 4 ) & 0xf );
            nibbles.push( frame[ i ] & 0xf );
        }

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.connect( gain );
        if ( analyser ) {
            gain.connect( analyser );
            analyser.connect( ctx.destination );
        } else {
            gain.connect( ctx.destination );
        }

        const vol = profile.volume;
        let t = ctx.currentTime + 0.15;
        const startAt = t;

        function tone( toneId, durMs ) {
            const dur = durMs / 1000;
            osc.frequency.setValueAtTime( freqFor( profile, toneId ), t );
            gain.gain.setValueAtTime( 0.0001, t );
            gain.gain.linearRampToValueAtTime( vol, t + 0.006 );
            gain.gain.setValueAtTime( vol, t + dur - 0.006 );
            gain.gain.linearRampToValueAtTime( 0.0001, t + dur );
            t += dur;
        }

        gain.gain.setValueAtTime( 0.0001, startAt );
        tone( TONE_START, START_MS );
        tone( TONE_GAP, GAP_MS );
        for ( let i = 0; i < nibbles.length; i++ ) {
            tone( TONE_DATA0 + nibbles[ i ], SYMBOL_MS );
            tone( TONE_GAP, GAP_MS );
        }
        tone( TONE_END, END_MS );

        osc.start( startAt );
        osc.stop( t + 0.05 );

        return new Promise( function ( resolve ) {
            osc.onended = function () {
                if ( analyser ) {
                    analyser.disconnect();
                }
                resolve();
            };
        } );
    }

    function estimateDurationMs( text ) {
        const byteLen = new TextEncoder().encode( text ).length + 4;
        return START_MS + GAP_MS + byteLen * 2 * ( SYMBOL_MS + GAP_MS ) + END_MS + 200;
    }

    function ackDurationMs() {
        return START_MS + GAP_MS + 4 * 2 * ( SYMBOL_MS + GAP_MS ) + END_MS + 200;
    }

    /* ------------------------------------------------------------------ */
    /* Receiver                                                           */
    /* ------------------------------------------------------------------ */

    /*
     * Peak-picking tone detector. Scans only the profile's band, requires
     * the peak to stand well above the band average, and snaps the
     * (parabolically refined) peak frequency to the nearest tone id.
     */
    function detectTone( analyser, sampleRate, profile, buf ) {
        analyser.getByteFrequencyData( buf );
        const binHz = sampleRate / analyser.fftSize;
        const range = bandRange( profile );
        const loBin = Math.max( 1, Math.floor( range.lo / binHz ) );
        const hiBin = Math.min( buf.length - 2, Math.ceil( range.hi / binHz ) );

        let peak = 0;
        let peakBin = -1;
        let sum = 0;
        for ( let i = loBin; i <= hiBin; i++ ) {
            sum += buf[ i ];
            if ( buf[ i ] > peak ) {
                peak = buf[ i ];
                peakBin = i;
            }
        }
        const avg = sum / ( hiBin - loBin + 1 );
        if ( peakBin < 0 || peak < 45 || peak < avg * 2.2 ) {
            return { toneId: null, freq: 0, level: peak };
        }

        /* Parabolic interpolation around the peak bin for sub-bin accuracy. */
        const y0 = buf[ peakBin - 1 ];
        const y1 = buf[ peakBin ];
        const y2 = buf[ peakBin + 1 ];
        const denom = y0 - 2 * y1 + y2;
        const offset = denom === 0 ? 0 : 0.5 * ( y0 - y2 ) / denom;
        const freq = ( peakBin + offset ) * binHz;

        const toneId = Math.round( ( freq - profile.base ) / STEP );
        if ( toneId < 0 || toneId >= TONE_COUNT ) {
            return { toneId: null, freq: freq, level: peak };
        }
        if ( Math.abs( freq - freqFor( profile, toneId ) ) > TONE_TOL ) {
            return { toneId: null, freq: freq, level: peak };
        }
        return { toneId: toneId, freq: freq, level: peak };
    }

    function Receiver( callbacks ) {
        this.callbacks = callbacks;    /* { onFrame, onStateChange, onPartial } */
        this.ctx = null;
        this.stream = null;
        this.analyser = null;
        this.timer = null;
        this.profile = PROFILES.audible;
        this.encCode = null;
        this.muted = false;
        this.running = false;
        this._resetState();
    }

    Receiver.prototype._resetState = function () {
        this.phase = 'idle';           /* idle | receiving */
        this.nibbles = [];
        this.candidateId = null;
        this.candidateCount = 0;
        this.acceptedId = null;
        this.gapSeen = false;
        this.lastToneAt = 0;
        this.lastPartialLen = -1;
    };

    /*
     * Streams the payload decoded so far to onPartial while a data frame
     * is still arriving, so the UI can preview the incoming message.
     * Fires only when another full payload byte has landed.
     */
    Receiver.prototype._emitPartial = function () {
        if ( !this.callbacks.onPartial || this.nibbles.length < 4 ) {
            return;
        }
        const byteCount = Math.floor( this.nibbles.length / 2 );
        const bytes = new Uint8Array( byteCount );
        for ( let i = 0; i < byteCount; i++ ) {
            bytes[ i ] = ( this.nibbles[ i * 2 ] << 4 ) | this.nibbles[ i * 2 + 1 ];
        }
        if ( bytes[ 0 ] !== TYPE_DATA ) {
            return;
        }
        const length = bytes[ 1 ] & 0x7f;
        const payload = bytes.slice( 3, Math.min( 3 + length, byteCount ) );
        if ( payload.length === this.lastPartialLen ) {
            return;
        }
        this.lastPartialLen = payload.length;
        this.callbacks.onPartial( {
            encrypted: ( bytes[ 1 ] & 0x80 ) !== 0,
            length: length,
            payload: payload
        } );
    };

    Receiver.prototype.start = async function ( ctx ) {
        if ( this.running ) {
            return;
        }
        this.ctx = ctx;
        /* Disable browser DSP — echo cancellation and noise suppression
           destroy high-frequency carriers. */
        this.stream = await navigator.mediaDevices.getUserMedia( {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        } );
        const source = ctx.createMediaStreamSource( this.stream );
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = FFT_SIZE;
        this.analyser.smoothingTimeConstant = 0;
        source.connect( this.analyser );
        this.freqBuf = new Uint8Array( this.analyser.frequencyBinCount );
        this._resetState();
        this.running = true;
        const self = this;
        this.timer = setInterval( function () {
            self._poll();
        }, POLL_MS );
    };

    Receiver.prototype.stop = function () {
        if ( this.timer ) {
            clearInterval( this.timer );
            this.timer = null;
        }
        if ( this.stream ) {
            this.stream.getTracks().forEach( function ( track ) {
                track.stop();
            } );
            this.stream = null;
        }
        this.analyser = null;
        this.running = false;
        this._resetState();
    };

    Receiver.prototype._emitState = function ( state ) {
        if ( this.callbacks.onStateChange ) {
            this.callbacks.onStateChange( state );
        }
    };

    Receiver.prototype._poll = function () {
        if ( !this.running || this.muted ) {
            return;
        }
        const result = detectTone( this.analyser, this.ctx.sampleRate, this.profile, this.freqBuf );
        const now = performance.now();

        /* Debounce: a tone must be seen on consecutive polls to count. */
        if ( result.toneId === this.candidateId && result.toneId !== null ) {
            this.candidateCount++;
        } else {
            this.candidateId = result.toneId;
            this.candidateCount = result.toneId === null ? 0 : 1;
        }
        const stable = this.candidateCount >= 2 ? this.candidateId : null;

        if ( this.phase === 'idle' ) {
            if ( stable === TONE_START && this.candidateCount >= 3 ) {
                this.phase = 'receiving';
                this.nibbles = [];
                this.acceptedId = TONE_START;
                this.gapSeen = false;
                this.lastToneAt = now;
                this._emitState( 'receiving' );
            }
            return;
        }

        /* phase === receiving */
        if ( stable !== null ) {
            this.lastToneAt = now;
        }
        if ( now - this.lastToneAt > 2000 ) {
            this._finish( { ok: false, reason: 'Signal lost mid-message' } );
            return;
        }

        if ( stable === TONE_GAP ) {
            this.gapSeen = true;
            this.acceptedId = TONE_GAP;
        } else if ( stable === TONE_END && this.candidateCount >= 3 ) {
            this._finalizeNibbles();
        } else if ( stable !== null && stable >= TONE_DATA0 && stable < TONE_END ) {
            if ( this.gapSeen || stable !== this.acceptedId ) {
                this.nibbles.push( stable - TONE_DATA0 );
                this.acceptedId = stable;
                this.gapSeen = false;
                if ( this.nibbles.length > ( MAX_PAYLOAD + 4 ) * 2 ) {
                    this._finish( { ok: false, reason: 'Frame overflow' } );
                    return;
                }
                this._emitPartial();
            }
        }
    };

    Receiver.prototype._finalizeNibbles = function () {
        if ( this.nibbles.length < 8 || this.nibbles.length % 2 !== 0 ) {
            this._finish( { ok: false, reason: 'Incomplete frame (' + this.nibbles.length + ' symbols)' } );
            return;
        }
        const bytes = new Uint8Array( this.nibbles.length / 2 );
        for ( let i = 0; i < bytes.length; i++ ) {
            bytes[ i ] = ( this.nibbles[ i * 2 ] << 4 ) | this.nibbles[ i * 2 + 1 ];
        }
        this._finish( parseFrame( bytes, this.encCode ) );
    };

    Receiver.prototype._finish = function ( result ) {
        this._resetState();
        this._emitState( 'listening' );
        if ( this.callbacks.onFrame ) {
            this.callbacks.onFrame( result );
        }
    };

    return {
        PROFILES: PROFILES,
        STEP: STEP,
        TONE_COUNT: TONE_COUNT,
        MAX_PAYLOAD: MAX_PAYLOAD,
        freqFor: freqFor,
        bandRange: bandRange,
        buildFrame: buildFrame,
        buildAckFrame: buildAckFrame,
        parseFrame: parseFrame,
        send: send,
        estimateDurationMs: estimateDurationMs,
        ackDurationMs: ackDurationMs,
        Receiver: Receiver
    };

} )();
