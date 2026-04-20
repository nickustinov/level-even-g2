# Level — Even Realities G2

A spirit-level app for Even Realities G2 smart glasses. Reads the IMU, shows a construction-style bubble vial with a roll readout on the glasses display.

## Features

- Unicode bubble vial that aligns to the pixel grid (heavy box-drawing chars + ideographic space padding).
- Single-tap zero calibration, persisted across launches via the companion app's local storage.
- Double-tap to exit.
- Bubble rises to the high side, like a real spirit level.
- IMU watchdog re-arms the sensor if frames stop arriving.

## Develop

```bash
npm install
npm run dev        # Vite on :5173
npm run qr         # QR for real glasses
npm run simulate   # desktop simulator
```

## Pack

```bash
npm run pack       # produces an .ehpk
```

## How it works

- `imuControl(true, P100)` streams 10 Hz accelerometer samples.
- Roll is derived from the gravity vector: `atan2(y, z)`.
- Samples are low-pass filtered for stability.
- The bubble position, rail glyphs (`━ ┳ ┻ ●`) and ideographic space (`\u3000`) use fixed 20px widths so the bubble tracks the vial ticks to the pixel.
- Text is pushed via `textContainerUpgrade` with serialized writes and coalesced pending frames.

## Notes

- Pitch is not shown — glasses worn on the nose are always at an arbitrary pitch, so it's not useful.
- Calibration reset button is available in the companion app's WebView.
