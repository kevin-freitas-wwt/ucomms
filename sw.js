/*
 * Ucomms service worker — cache-first so the app fully works offline.
 * Bump CACHE version when assets change.
 */

const CACHE = 'ucomms-v7';

const ASSETS = [
    './',
    './index.html',
    './css/styles.css',
    './js/cipher.js',
    './js/codec.js',
    './js/visualizer.js',
    './js/app.js',
    './manifest.json',
    './icon.svg'
];

self.addEventListener( 'install', function ( event ) {
    event.waitUntil(
        caches.open( CACHE ).then( function ( cache ) {
            return cache.addAll( ASSETS );
        } ).then( function () {
            return self.skipWaiting();
        } )
    );
} );

self.addEventListener( 'activate', function ( event ) {
    event.waitUntil(
        caches.keys().then( function ( keys ) {
            return Promise.all(
                keys.filter( function ( key ) {
                    return key !== CACHE;
                } ).map( function ( key ) {
                    return caches.delete( key );
                } )
            );
        } ).then( function () {
            return self.clients.claim();
        } )
    );
} );

self.addEventListener( 'fetch', function ( event ) {
    if ( event.request.method !== 'GET' ) {
        return;
    }
    event.respondWith(
        caches.match( event.request ).then( function ( cached ) {
            if ( cached ) {
                return cached;
            }
            return fetch( event.request ).then( function ( response ) {
                if ( response && response.ok && event.request.url.startsWith( self.location.origin ) ) {
                    const copy = response.clone();
                    caches.open( CACHE ).then( function ( cache ) {
                        cache.put( event.request, copy );
                    } );
                }
                return response;
            } );
        } )
    );
} );
