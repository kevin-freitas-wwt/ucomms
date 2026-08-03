/*
 * Ucomms app — UI glue: chat log, settings, send/receive orchestration,
 * delivery acknowledgements, offline (service worker) registration.
 */

( function () {

    const STORAGE_MESSAGES = 'ucomms.messages';
    const STORAGE_SETTINGS = 'ucomms.settings';
    const STORAGE_DEVICE = 'ucomms.deviceId';

    /* How long the sender listens for acks after a transmission: max ack
       delay (2.5 s) + ack transmission (~2.1 s) + margin. */
    const ACK_WINDOW_MS = 6000;

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
        composer: document.getElementById( 'composer' ),
        sendProgress: document.getElementById( 'sendProgress' ),
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
    let pendingAck = null;    /* { msgId, localId, deviceIds: Set } while awaiting acks */

    /* Stable random per-device id (1–255) so receivers can be counted. */
    let deviceId = parseInt( localStorage.getItem( STORAGE_DEVICE ) || '0', 10 );
    if ( !deviceId || deviceId < 1 || deviceId > 255 ) {
        deviceId = 1 + Math.floor( Math.random() * 255 );
        localStorage.setItem( STORAGE_DEVICE, String( deviceId ) );
    }

    const viz = new Visualizer( el.vizCanvas, el.vizBandLabel, el.vizPeakLabel );

    const receiver = new Codec.Receiver( {
        onFrame: onFrameReceived,
        onPartial: onPartialReceived,
        onStateChange: function ( state ) {
            if ( listening ) {
                setStatus( state );
            }
        }
    } );

    let incoming = null;    /* { el, textEl } — live preview bubble while a frame arrives */

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
            const saved = JSON.parse( localStorage.getItem( STORAGE_MESSAGES ) || '[]' );
            /* A reload mid-send can leave a message stuck in 'sending'. */
            saved.forEach( function ( msg ) {
                if ( msg.status === 'sending' ) {
                    msg.status = 'unknown';
                }
            } );
            return saved;
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
        if ( incoming ) {
            el.chatLog.appendChild( incoming.el );
        }
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
        if ( msg.dir === 'out' && msg.status ) {
            const delivery = document.createElement( 'span' );
            delivery.className = 'delivery';
            if ( msg.status === 'sending' ) {
                delivery.textContent = 'sending…';
            } else if ( msg.status === 'delivered' ) {
                delivery.classList.add( 'ok' );
                const n = ( msg.acks || [] ).length;
                delivery.textContent = '✓ received by ' + n + ( n === 1 ? ' device' : ' devices' );
            } else if ( msg.status === 'failed' ) {
                delivery.classList.add( 'none' );
                delivery.textContent = 'not received by anyone';
            } else {
                delivery.classList.add( 'none' );
                delivery.textContent = 'delivery unconfirmed';
            }
            div.appendChild( delivery );
            if ( msg.status === 'failed' || msg.status === 'unknown' ) {
                const btn = document.createElement( 'button' );
                btn.className = 'resend-btn';
                btn.textContent = 'Resend';
                btn.addEventListener( 'click', function () {
                    resendMessage( msg.id );
                } );
                div.appendChild( btn );
            }
        }
        return div;
    }

    function addMessage( msg ) {
        messages.push( msg );
        saveMessages();
        renderMessages();
    }

    function startProgress( durMs ) {
        const bar = el.sendProgress;
        bar.style.transition = 'none';
        bar.style.width = '0';
        void bar.offsetWidth;    /* flush so the new transition animates from 0 */
        bar.style.transition = 'width ' + durMs + 'ms linear';
        bar.style.width = '100%';
    }

    function endProgress() {
        const bar = el.sendProgress;
        setTimeout( function () {
            bar.style.transition = 'none';
            bar.style.width = '0';
        }, 250 );
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

    function makeTxAnalyser( ctx ) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        viz.setTxAnalyser( analyser, ctx.sampleRate );
        return analyser;
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
        const msg = {
            id: Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 7 ),
            dir: 'out',
            text: text,
            time: Date.now(),
            mode: settings.mode,
            encrypted: !!encCode,
            status: 'sending',
            acks: []
        };
        await transmit( msg, encCode, true );
    }

    async function resendMessage( localId ) {
        if ( sending ) {
            return;
        }
        const msg = messages.find( function ( m ) {
            return m.id === localId;
        } );
        if ( !msg ) {
            return;
        }
        const encCode = activeEncCode();
        if ( encCode === undefined ) {
            toast( 'Set a valid 6-digit code (0–5) or turn encryption off' );
            return;
        }
        msg.mode = settings.mode;
        msg.encrypted = !!encCode;
        msg.time = Date.now();
        await transmit( msg, encCode, false );
    }

    /*
     * Transmits a message frame, then listens for acknowledgements for
     * ACK_WINDOW_MS to learn how many devices received it.
     */
    async function transmit( msg, encCode, isNew ) {
        const msgId = Math.floor( Math.random() * 256 );
        let frame;
        try {
            frame = Codec.buildFrame( msg.text, encCode, msgId );
        } catch ( e ) {
            toast( e.message );
            return;
        }

        if ( isNew ) {
            messages.push( msg );
            el.msgInput.value = '';
        }
        msg.status = 'sending';
        msg.acks = [];
        saveMessages();
        renderMessages();

        const ctx = getAudioCtx();
        sending = true;
        el.sendBtn.disabled = true;
        el.composer.classList.add( 'sending' );
        setStatus( 'sending' );
        receiver.muted = true;    /* don't decode our own transmission */
        startProgress( Codec.estimateDurationMs( msg.text ) );

        let sendFailed = false;
        try {
            await Codec.send( ctx, currentProfile(), frame, makeTxAnalyser( ctx ) );
        } catch ( e ) {
            toast( 'Send failed: ' + e.message );
            sendFailed = true;
        } finally {
            viz.setTxAnalyser( null );
            endProgress();
            sending = false;
            el.sendBtn.disabled = false;
            el.composer.classList.remove( 'sending' );
            setTimeout( function () {
                receiver.muted = false;
            }, 300 );
            setStatus( listening ? 'listening' : 'idle' );
        }

        if ( sendFailed ) {
            msg.status = 'unknown';
            saveMessages();
            renderMessages();
            return;
        }
        await collectAcks( msg, msgId );
    }

    async function collectAcks( msg, msgId ) {
        let tempListen = false;
        if ( !listening ) {
            try {
                receiver.profile = currentProfile();
                receiver.encCode = activeEncCode() || null;
                await receiver.start( getAudioCtx() );
                viz.setRxAnalyser( receiver.analyser, getAudioCtx().sampleRate );
                tempListen = true;
            } catch ( e ) {
                /* No mic — can't hear acks, delivery stays unknown. */
                msg.status = 'unknown';
                saveMessages();
                renderMessages();
                return;
            }
        }

        pendingAck = { msgId: msgId, localId: msg.id, deviceIds: new Set() };
        await new Promise( function ( resolve ) {
            setTimeout( resolve, ACK_WINDOW_MS );
        } );
        const count = pendingAck ? pendingAck.deviceIds.size : ( msg.acks || [] ).length;
        pendingAck = null;

        if ( tempListen && !listening ) {
            receiver.stop();
            viz.setRxAnalyser( null );
        }
        msg.status = count > 0 ? 'delivered' : 'failed';
        saveMessages();
        renderMessages();
    }

    async function toggleListening() {
        if ( listening ) {
            listening = false;
            receiver.stop();
            viz.setRxAnalyser( null );
            el.listenBtn.classList.remove( 'active' );
            el.listenBtn.setAttribute( 'aria-pressed', 'false' );
            setStatus( 'idle' );
            return;
        }
        try {
            const ctx = getAudioCtx();
            receiver.profile = currentProfile();
            receiver.encCode = activeEncCode() || null;
            if ( !receiver.running ) {
                await receiver.start( ctx );
            }
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

    /* ---- live receive preview: reveal complete words as bytes land ---- */

    function safeDecodeText( bytes ) {
        let text = new TextDecoder( 'utf-8' ).decode( bytes );
        /* Trailing replacement chars are just an unfinished multi-byte
           sequence — hide them until the rest arrives. */
        while ( text.length > 0 && text.charCodeAt( text.length - 1 ) === 0xfffd ) {
            text = text.slice( 0, -1 );
        }
        return text;
    }

    function onPartialReceived( info ) {
        if ( !incoming ) {
            const bubble = document.createElement( 'div' );
            bubble.className = 'bubble in receiving';
            const textEl = document.createElement( 'span' );
            textEl.className = 'partial-text';
            const dots = document.createElement( 'span' );
            dots.className = 'ellipsis';
            for ( let i = 0; i < 3; i++ ) {
                dots.appendChild( document.createElement( 'span' ) );
            }
            bubble.appendChild( textEl );
            bubble.appendChild( dots );
            const emptyState = el.chatLog.querySelector( '.chat-empty' );
            if ( emptyState ) {
                emptyState.remove();
            }
            el.chatLog.appendChild( bubble );
            incoming = { el: bubble, textEl: textEl };
        }
        let text = '';
        if ( info.encrypted ) {
            const code = activeEncCode();
            if ( !code ) {
                incoming.textEl.textContent = '🔒 ';
                el.chatLog.scrollTop = el.chatLog.scrollHeight;
                return;
            }
            text = safeDecodeText( Cipher.decrypt( info.payload, code ) );
        } else {
            text = safeDecodeText( info.payload );
        }
        /* One word at a time: only text up to the last completed word. */
        const lastSpace = text.lastIndexOf( ' ' );
        incoming.textEl.textContent = lastSpace >= 0 ? text.slice( 0, lastSpace + 1 ) : '';
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
    }

    function clearIncoming() {
        if ( incoming ) {
            incoming.el.remove();
            incoming = null;
        }
    }

    function onFrameReceived( result ) {
        if ( result.kind === 'ack' ) {
            if ( result.ok ) {
                handleAck( result );
            }
            return;    /* acks never appear in the chat log */
        }
        clearIncoming();
        if ( result.ok ) {
            addMessage( {
                id: Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 7 ),
                dir: 'in',
                text: result.text,
                time: Date.now(),
                mode: settings.mode,
                encrypted: !!result.encrypted
            } );
            if ( navigator.vibrate ) {
                navigator.vibrate( 80 );
            }
            scheduleAckReply( result.msgId );
        } else {
            addMessage( {
                dir: 'error',
                text: '⚠ ' + result.reason,
                time: Date.now(),
                mode: settings.mode
            } );
        }
    }

    function handleAck( result ) {
        if ( !pendingAck || result.msgId !== pendingAck.msgId ) {
            return;
        }
        pendingAck.deviceIds.add( result.deviceId );
        const msg = messages.find( function ( m ) {
            return m.id === pendingAck.localId;
        } );
        if ( msg ) {
            msg.acks = Array.from( pendingAck.deviceIds );
            msg.status = 'delivered';
            saveMessages();
            renderMessages();
        }
    }

    /*
     * Replies to a received data frame with an ack after a random delay
     * (0.3–2.5 s) so several receivers don't all ack at the same instant.
     */
    function scheduleAckReply( msgId ) {
        const delay = 300 + Math.random() * 2200;
        setTimeout( async function () {
            if ( sending ) {
                return;    /* mid-transmission; skip rather than collide */
            }
            const ctx = getAudioCtx();
            receiver.muted = true;
            try {
                await Codec.send( ctx, currentProfile(), Codec.buildAckFrame( msgId, deviceId ), makeTxAnalyser( ctx ) );
            } catch ( e ) {
                /* ack is best-effort */
            } finally {
                viz.setTxAnalyser( null );
                setTimeout( function () {
                    receiver.muted = false;
                }, 300 );
            }
        }, delay );
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
