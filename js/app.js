/*
 * Ucomms app — UI glue: chat log, settings, send/receive orchestration,
 * offline (service worker) registration.
 */

( function () {

    const STORAGE_MESSAGES = 'ucomms.messages';
    const STORAGE_SETTINGS = 'ucomms.settings';

    const el = {
        statusDot: document.getElementById( 'statusDot' ),
        offlineBadge: document.getElementById( 'offlineBadge' ),
        settingsBtn: document.getElementById( 'settingsBtn' ),
        settingsPanel: document.getElementById( 'settingsPanel' ),
        modeHint: document.getElementById( 'modeHint' ),
        segButtons: Array.prototype.slice.call( document.querySelectorAll( '.seg-btn' ) ),
        encToggle: document.getElementById( 'encToggle' ),
        codeRow: document.getElementById( 'codeRow' ),
        codeInput: document.getElementById( 'codeInput' ),
        vizToggle: document.getElementById( 'vizToggle' ),
        clearBtn: document.getElementById( 'clearBtn' ),
        chatLog: document.getElementById( 'chatLog' ),
        vizWrap: document.getElementById( 'vizWrap' ),
        vizCanvas: document.getElementById( 'vizCanvas' ),
        vizBandLabel: document.getElementById( 'vizBandLabel' ),
        vizPeakLabel: document.getElementById( 'vizPeakLabel' ),
        listenBtn: document.getElementById( 'listenBtn' ),
        msgInput: document.getElementById( 'msgInput' ),
        sendBtn: document.getElementById( 'sendBtn' ),
        toast: document.getElementById( 'toast' )
    };

    let settings = loadSettings();
    let messages = loadMessages();
    let audioCtx = null;
    let sending = false;
    let listening = false;
    let toastTimer = null;

    const viz = new Visualizer( el.vizCanvas, el.vizBandLabel, el.vizPeakLabel );

    const receiver = new Codec.Receiver( {
        onFrame: onFrameReceived,
        onStateChange: function ( state ) {
            if ( listening ) {
                setStatus( state );
            }
        }
    } );

    /* ------------------------------------------------------------------ */
    /* Persistence                                                        */
    /* ------------------------------------------------------------------ */

    function loadSettings() {
        try {
            const saved = JSON.parse( localStorage.getItem( STORAGE_SETTINGS ) || '{}' );
            return {
                mode: Codec.PROFILES[ saved.mode ] ? saved.mode : 'audible',
                encEnabled: !!saved.encEnabled,
                encCode: /^[0-5]{6}$/.test( saved.encCode || '' ) ? saved.encCode : '',
                vizEnabled: saved.vizEnabled !== false
            };
        } catch ( e ) {
            return { mode: 'audible', encEnabled: false, encCode: '', vizEnabled: true };
        }
    }

    function saveSettings() {
        localStorage.setItem( STORAGE_SETTINGS, JSON.stringify( settings ) );
    }

    function loadMessages() {
        try {
            return JSON.parse( localStorage.getItem( STORAGE_MESSAGES ) || '[]' );
        } catch ( e ) {
            return [];
        }
    }

    function saveMessages() {
        localStorage.setItem( STORAGE_MESSAGES, JSON.stringify( messages.slice( -200 ) ) );
    }

    /* ------------------------------------------------------------------ */
    /* UI helpers                                                         */
    /* ------------------------------------------------------------------ */

    function toast( text ) {
        el.toast.textContent = text;
        el.toast.hidden = false;
        clearTimeout( toastTimer );
        toastTimer = setTimeout( function () {
            el.toast.hidden = true;
        }, 3200 );
    }

    function setStatus( state ) {
        el.statusDot.className = 'status-dot' + ( state === 'idle' ? '' : ' ' + state );
    }

    function formatTime( ts ) {
        return new Date( ts ).toLocaleTimeString( [], { hour: '2-digit', minute: '2-digit' } );
    }

    function renderMessages() {
        el.chatLog.innerHTML = '';
        if ( messages.length === 0 ) {
            const empty = document.createElement( 'div' );
            empty.className = 'chat-empty';
            empty.innerHTML = 'No messages yet.<br>Type a message and it plays as sound.<br>Tap the mic on the other device to receive.';
            el.chatLog.appendChild( empty );
            return;
        }
        messages.forEach( function ( msg ) {
            el.chatLog.appendChild( bubbleFor( msg ) );
        } );
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
    }

    function bubbleFor( msg ) {
        const div = document.createElement( 'div' );
        div.className = 'bubble ' + msg.dir;
        const body = document.createElement( 'span' );
        body.textContent = msg.text;
        div.appendChild( body );
        if ( msg.dir !== 'error' ) {
            const meta = document.createElement( 'span' );
            meta.className = 'meta';
            meta.textContent = formatTime( msg.time ) +
                ' · ' + Codec.PROFILES[ msg.mode ].label.toLowerCase() +
                ( msg.encrypted ? ' · 🔒' : '' );
            div.appendChild( meta );
        }
        return div;
    }

    function addMessage( msg ) {
        messages.push( msg );
        saveMessages();
        renderMessages();
    }

    /* ------------------------------------------------------------------ */
    /* Audio                                                              */
    /* ------------------------------------------------------------------ */

    function getAudioCtx() {
        if ( !audioCtx ) {
            audioCtx = new ( window.AudioContext || window.webkitAudioContext )();
        }
        if ( audioCtx.state === 'suspended' ) {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function currentProfile() {
        return Codec.PROFILES[ settings.mode ];
    }

    function activeEncCode() {
        if ( !settings.encEnabled ) {
            return null;
        }
        if ( !Cipher.isValidCode( settings.encCode ) ) {
            return undefined;    /* enabled but invalid */
        }
        return settings.encCode;
    }

    async function sendMessage() {
        const text = el.msgInput.value.trim();
        if ( !text || sending ) {
            return;
        }
        const encCode = activeEncCode();
        if ( encCode === undefined ) {
            toast( 'Set a valid 6-digit code (0–5) or turn encryption off' );
            openSettings( true );
            el.codeInput.focus();
            return;
        }

        let frame;
        try {
            frame = Codec.buildFrame( text, encCode );
        } catch ( e ) {
            toast( e.message );
            return;
        }

        const ctx = getAudioCtx();
        const profile = currentProfile();
        sending = true;
        el.sendBtn.disabled = true;
        setStatus( 'sending' );
        receiver.muted = true;    /* don't decode our own transmission */

        const txAnalyser = ctx.createAnalyser();
        txAnalyser.fftSize = 2048;
        txAnalyser.smoothingTimeConstant = 0;
        viz.setTxAnalyser( txAnalyser, ctx.sampleRate );

        try {
            await Codec.send( ctx, profile, frame, txAnalyser );
            addMessage( {
                dir: 'out',
                text: text,
                time: Date.now(),
                mode: profile.id,
                encrypted: !!encCode
            } );
            el.msgInput.value = '';
        } catch ( e ) {
            toast( 'Send failed: ' + e.message );
        } finally {
            viz.setTxAnalyser( null );
            sending = false;
            el.sendBtn.disabled = false;
            setTimeout( function () {
                receiver.muted = false;
            }, 300 );
            setStatus( listening ? 'listening' : 'idle' );
        }
    }

    async function toggleListening() {
        if ( listening ) {
            receiver.stop();
            viz.setRxAnalyser( null );
            listening = false;
            el.listenBtn.classList.remove( 'active' );
            el.listenBtn.setAttribute( 'aria-pressed', 'false' );
            setStatus( 'idle' );
            return;
        }
        try {
            const ctx = getAudioCtx();
            receiver.profile = currentProfile();
            receiver.encCode = activeEncCode() || null;
            await receiver.start( ctx );
            viz.setRxAnalyser( receiver.analyser, ctx.sampleRate );
            listening = true;
            el.listenBtn.classList.add( 'active' );
            el.listenBtn.setAttribute( 'aria-pressed', 'true' );
            setStatus( 'listening' );
            toast( 'Listening on ' + currentProfile().label.toLowerCase() + ' band' );
        } catch ( e ) {
            toast( 'Microphone unavailable: ' + ( e.name === 'NotAllowedError' ? 'permission denied' : e.message ) );
        }
    }

    function onFrameReceived( result ) {
        if ( result.ok ) {
            addMessage( {
                dir: 'in',
                text: result.text,
                time: Date.now(),
                mode: settings.mode,
                encrypted: !!result.encrypted
            } );
            if ( navigator.vibrate ) {
                navigator.vibrate( 80 );
            }
        } else {
            addMessage( {
                dir: 'error',
                text: '⚠ ' + result.reason,
                time: Date.now(),
                mode: settings.mode
            } );
        }
    }

    /* ------------------------------------------------------------------ */
    /* Settings UI                                                        */
    /* ------------------------------------------------------------------ */

    function openSettings( open ) {
        el.settingsPanel.hidden = !open;
        el.settingsBtn.setAttribute( 'aria-expanded', String( open ) );
    }

    function applyMode( mode ) {
        settings.mode = mode;
        saveSettings();
        const profile = currentProfile();
        el.segButtons.forEach( function ( btn ) {
            btn.setAttribute( 'aria-checked', String( btn.dataset.mode === mode ) );
        } );
        el.modeHint.textContent = profile.hint;
        receiver.profile = profile;
        viz.setProfile( profile );
    }

    function applyVizEnabled( enabled ) {
        settings.vizEnabled = enabled;
        saveSettings();
        el.vizToggle.checked = enabled;
        el.vizWrap.hidden = !enabled;
        viz.setEnabled( enabled );
    }

    function applyEncryption() {
        el.encToggle.checked = settings.encEnabled;
        el.codeRow.hidden = !settings.encEnabled;
        el.codeInput.value = settings.encCode;
        receiver.encCode = activeEncCode() || null;
    }

    /* ------------------------------------------------------------------ */
    /* Wiring                                                             */
    /* ------------------------------------------------------------------ */

    el.settingsBtn.addEventListener( 'click', function () {
        openSettings( el.settingsPanel.hidden );
    } );

    el.segButtons.forEach( function ( btn ) {
        btn.addEventListener( 'click', function () {
            applyMode( btn.dataset.mode );
        } );
    } );

    el.encToggle.addEventListener( 'change', function () {
        settings.encEnabled = el.encToggle.checked;
        saveSettings();
        applyEncryption();
    } );

    el.codeInput.addEventListener( 'input', function () {
        const cleaned = el.codeInput.value.replace( /[^0-5]/g, '' ).slice( 0, 6 );
        if ( cleaned !== el.codeInput.value ) {
            el.codeInput.value = cleaned;
        }
        settings.encCode = cleaned;
        saveSettings();
        el.codeInput.classList.toggle( 'invalid', cleaned.length > 0 && cleaned.length < 6 );
        receiver.encCode = activeEncCode() || null;
    } );

    el.vizToggle.addEventListener( 'change', function () {
        applyVizEnabled( el.vizToggle.checked );
    } );

    el.clearBtn.addEventListener( 'click', function () {
        messages = [];
        saveMessages();
        renderMessages();
        toast( 'Chat cleared' );
    } );

    el.sendBtn.addEventListener( 'click', sendMessage );
    el.msgInput.addEventListener( 'keydown', function ( event ) {
        if ( event.key === 'Enter' ) {
            event.preventDefault();
            sendMessage();
        }
    } );

    el.listenBtn.addEventListener( 'click', toggleListening );

    function updateOfflineBadge() {
        el.offlineBadge.hidden = navigator.onLine;
    }
    window.addEventListener( 'online', updateOfflineBadge );
    window.addEventListener( 'offline', updateOfflineBadge );

    /* Offline mode: cache-first service worker. */
    if ( 'serviceWorker' in navigator && ( location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1' ) ) {
        navigator.serviceWorker.register( 'sw.js' ).catch( function () {
            /* offline caching unavailable; app still works */
        } );
    }

    /* ------------------------------------------------------------------ */
    /* Init                                                               */
    /* ------------------------------------------------------------------ */

    applyMode( settings.mode );
    applyEncryption();
    applyVizEnabled( settings.vizEnabled );
    updateOfflineBadge();
    renderMessages();

} )();
