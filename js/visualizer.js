/*
 * Ucomms visualizer — SDR-style waterfall plot of the active profile's
 * frequency band. Frequency runs left → right, time flows top → bottom
 * (newest row at the top). A static frequency axis sits along the bottom.
 * Fed by the receive and/or transmit analysers.
 */

const Visualizer = ( function () {

    const ROW_PX = 2;           /* rows scrolled per frame (CSS-independent device px) */
    const AXIS_CSS_PX = 16;     /* height of the static frequency axis strip */
    const FRAME_MS = 33;        /* fixed row rate so scroll speed is consistent across displays */

    /* Precompute a 256-entry heat palette: black → deep blue → cyan →
       green → yellow → white, the classic waterfall colormap. */
    function buildPalette() {
        const palette = new Array( 256 );
        for ( let v = 0; v < 256; v++ ) {
            const t = v / 255;
            let r;
            let g;
            let b;
            if ( t < 0.22 ) {
                const k = t / 0.22;
                r = 5;
                g = 7 + 20 * k;
                b = 10 + 90 * k;
            } else if ( t < 0.45 ) {
                const k = ( t - 0.22 ) / 0.23;
                r = 5;
                g = 27 + 160 * k;
                b = 100 + 120 * k;
            } else if ( t < 0.7 ) {
                const k = ( t - 0.45 ) / 0.25;
                r = 5 + 100 * k;
                g = 187 + 50 * k;
                b = 220 - 160 * k;
            } else if ( t < 0.88 ) {
                const k = ( t - 0.7 ) / 0.18;
                r = 105 + 150 * k;
                g = 237 - 17 * k;
                b = 60 - 30 * k;
            } else {
                const k = ( t - 0.88 ) / 0.12;
                r = 255;
                g = 220 + 35 * k;
                b = 30 + 225 * k;
            }
            palette[ v ] = [ Math.round( r ), Math.round( g ), Math.round( b ) ];
        }
        return palette;
    }

    const PALETTE = buildPalette();

    function Visualizer( canvas, bandLabelEl, peakLabelEl ) {
        this.canvas = canvas;
        this.g = canvas.getContext( '2d' );
        this.bandLabelEl = bandLabelEl;
        this.peakLabelEl = peakLabelEl;
        this.rxAnalyser = null;
        this.txAnalyser = null;
        this.sampleRate = 48000;
        this.profile = null;
        this.enabled = false;
        this.timer = null;
        this.rxBuf = null;
        this.txBuf = null;
        this.rowImage = null;
        this._resize();
        const self = this;
        /* Track the canvas's displayed size directly: fires on window
           resizes AND when the panel goes from hidden (0 px) to visible,
           so the backing store never stays stretched at a stale size. */
        if ( typeof ResizeObserver !== 'undefined' ) {
            this.observer = new ResizeObserver( function () {
                self._resize();
            } );
            this.observer.observe( this.canvas );
        } else {
            window.addEventListener( 'resize', function () {
                self._resize();
            } );
        }
    }

    Visualizer.prototype._resize = function () {
        const dpr = Math.min( window.devicePixelRatio || 1, 2 );
        this.dpr = dpr;
        const cssWidth = this.canvas.clientWidth;
        const cssHeight = this.canvas.clientHeight || 160;
        if ( !cssWidth ) {
            return;    /* hidden; ResizeObserver will call again when shown */
        }
        if ( this.canvas.width === Math.floor( cssWidth * dpr ) &&
            this.canvas.height === Math.floor( cssHeight * dpr ) ) {
            return;
        }
        this.canvas.width = Math.floor( cssWidth * dpr );
        this.canvas.height = Math.floor( cssHeight * dpr );
        this.axisH = Math.floor( AXIS_CSS_PX * dpr );
        this.rowImage = this.g.createImageData( this.canvas.width, ROW_PX );
        this.g.fillStyle = '#05070a';
        this.g.fillRect( 0, 0, this.canvas.width, this.canvas.height );
        this._drawAxis();
    };

    Visualizer.prototype.setProfile = function ( profile ) {
        this.profile = profile;
        const range = Codec.bandRange( profile );
        if ( this.bandLabelEl ) {
            this.bandLabelEl.textContent = profile.label + ' band ' +
                ( range.lo / 1000 ).toFixed( 1 ) + '–' + ( range.hi / 1000 ).toFixed( 1 ) + ' kHz';
        }
        this._drawAxis();
    };

    Visualizer.prototype.setRxAnalyser = function ( analyser, sampleRate ) {
        this.rxAnalyser = analyser;
        if ( analyser ) {
            this.sampleRate = sampleRate;
            this.rxBuf = new Uint8Array( analyser.frequencyBinCount );
        }
    };

    Visualizer.prototype.setTxAnalyser = function ( analyser, sampleRate ) {
        this.txAnalyser = analyser;
        if ( analyser ) {
            this.sampleRate = sampleRate;
            this.txBuf = new Uint8Array( analyser.frequencyBinCount );
        }
    };

    Visualizer.prototype.setEnabled = function ( enabled ) {
        this.enabled = enabled;
        if ( enabled && this.timer === null ) {
            const self = this;
            this.timer = setInterval( function () {
                self._frame();
            }, FRAME_MS );
        }
        if ( !enabled && this.timer !== null ) {
            clearInterval( this.timer );
            this.timer = null;
        }
    };

    /* Static frequency axis strip along the bottom: baseline plus a tick
       and kHz label every 500 Hz across the active band. */
    Visualizer.prototype._drawAxis = function () {
        if ( !this.profile ) {
            return;
        }
        const g = this.g;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const dpr = this.dpr;
        const range = Codec.bandRange( this.profile );
        const span = range.hi - range.lo;

        g.fillStyle = '#0b0f14';
        g.fillRect( 0, h - this.axisH, w, this.axisH );
        g.fillStyle = '#2b3442';
        g.fillRect( 0, h - this.axisH, w, Math.max( 1, Math.floor( dpr ) ) );

        g.fillStyle = '#8b98a9';
        g.font = ( 9 * dpr ) + 'px -apple-system, sans-serif';
        g.textBaseline = 'bottom';

        const firstTick = Math.ceil( range.lo / 500 ) * 500;
        for ( let f = firstTick; f <= range.hi; f += 500 ) {
            const x = Math.round( ( ( f - range.lo ) / span ) * w );
            g.fillStyle = '#3d485a';
            g.fillRect( x, h - this.axisH, Math.max( 1, Math.floor( dpr ) ), 4 * dpr );
            g.fillStyle = '#8b98a9';
            const label = ( f / 1000 ).toFixed( 1 );
            const align = x > w - 26 * dpr ? 'right' : ( x < 14 * dpr ? 'left' : 'center' );
            g.textAlign = align;
            g.fillText( label, x, h - 2 * dpr );
        }
    };

    Visualizer.prototype._frame = function () {
        /* Fallback for environments where ResizeObserver doesn't fire:
           re-check the displayed size on every tick (no-op when synced). */
        this._resize();

        const g = this.g;
        const w = this.canvas.width;
        const waterfallH = this.canvas.height - this.axisH;
        if ( !this.profile || ( !this.rxAnalyser && !this.txAnalyser ) ) {
            return;
        }

        /* Scroll the waterfall region down by one row (newest at top). */
        g.drawImage(
            this.canvas,
            0, 0, w, waterfallH - ROW_PX,
            0, ROW_PX, w, waterfallH - ROW_PX
        );

        const range = Codec.bandRange( this.profile );
        const span = range.hi - range.lo;
        const fftSize = ( this.rxAnalyser || this.txAnalyser ).fftSize;
        const binHz = this.sampleRate / fftSize;

        if ( this.rxAnalyser ) {
            this.rxAnalyser.getByteFrequencyData( this.rxBuf );
        }
        if ( this.txAnalyser ) {
            try {
                this.txAnalyser.getByteFrequencyData( this.txBuf );
            } catch ( e ) {
                this.txAnalyser = null;
            }
        }

        /* Paint the new top row pixel-by-pixel: column x → frequency →
           FFT bin → palette color. */
        const data = this.rowImage.data;
        let peakVal = 0;
        let peakFreq = 0;
        for ( let x = 0; x < w; x++ ) {
            const freq = range.lo + ( x / w ) * span;
            const bin = Math.round( freq / binHz );
            let v = 0;
            if ( this.rxAnalyser && bin < this.rxBuf.length ) {
                v = this.rxBuf[ bin ];
            }
            if ( this.txAnalyser && this.txBuf && bin < this.txBuf.length && this.txBuf[ bin ] > v ) {
                v = this.txBuf[ bin ];
            }
            if ( v > peakVal ) {
                peakVal = v;
                peakFreq = freq;
            }
            const color = PALETTE[ v ];
            for ( let row = 0; row < ROW_PX; row++ ) {
                const idx = ( row * w + x ) * 4;
                data[ idx ] = color[ 0 ];
                data[ idx + 1 ] = color[ 1 ];
                data[ idx + 2 ] = color[ 2 ];
                data[ idx + 3 ] = 255;
            }
        }
        g.putImageData( this.rowImage, 0, 0 );

        if ( this.peakLabelEl ) {
            if ( peakVal > 45 ) {
                this.peakLabelEl.textContent = 'peak ' + Math.round( peakFreq ) + ' Hz';
            } else {
                this.peakLabelEl.textContent = '';
            }
        }
    };

    return Visualizer;

} )();
