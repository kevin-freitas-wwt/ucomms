# Ucomms — Sound Messenger

Front-end-only web app that sends text messages between nearby devices **as sound**. No server, no radio — pure Web Audio FSK modem, offline-capable PWA.

## Run

Needs a local web server (mic access + service worker require `localhost` or HTTPS):

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` — or serve over HTTPS / your LAN for phones (mic requires a secure context, so plain `http://192.168.x.x` will not grant mic access; use HTTPS or a tunnel for cross-device testing on phones).

## Use

1. Open the app on two devices near each other.
2. On the receiver, tap the **mic** button (grant mic permission).
3. On the sender, type a message and hit **send** — it plays as sound.
4. Both devices must be on the **same sound mode** (and same code if encryption on).

## Sound modes

| Mode | Band | Character |
|------|------|-----------|
| Audible | 1.0–3.3 kHz | Hearable chirps. Most robust. |
| Ultrasonic | 16.4–18.7 kHz | Faint/inaudible to most adults. |
| Silent | 18.8–21.1 kHz | Inaudible. Needs good speakers + mic; some hardware rolls off here. |

## Encryption

Toggle in settings. 6-digit code, digits **0–5 only** (base-6, 46,656 keys). XOR stream cipher seeded from the code — simple obfuscation as specified, not real cryptography. Checksum is computed over plaintext, so a wrong code is detected instead of showing garbage.

## Visualization

Optional scrolling spectrogram of the active band showing both transmitted and received signal energy.

## Protocol

- 19 sine tones per band, 120 Hz apart: START, GAP, 16 data nibbles, END.
- Each byte = 2 nibbles; each nibble tone (90 ms) is followed by a GAP tone (60 ms) so repeated symbols stay unambiguous.
- Data frame: `[type] [encFlag | length] [msgId] [payload ≤ 127 bytes] [XOR checksum]` → ~3 chars/sec.
- Ack frame: `[type] [msgId] [deviceId] [checksum]` — a receiver that decodes a data frame replies after a random 0.3–2.5 s delay (collision avoidance). The sender listens for ~6 s and counts unique device ids, showing "received by N"; zero acks offers a **Resend** button. Acks are always plaintext.
- Receiver: FFT peak detection (2048-point) with parabolic interpolation, debounced tone state machine, echo-cancellation/noise-suppression disabled to preserve high frequencies.

## Offline

Service worker caches all assets (cache-first). After first load the app works with no network. Messages persist in `localStorage`.
