# Development

[Back to README](../README.md)

## Development and verification

```sh
npm run check
npm test
npm run build
docker compose config --quiet
```

Tests cover QR challenge lifecycle, endpoint validation, AES-GCM interoperability, encrypted sharing requests, token rotation, legacy request signing, conversions, mapping validation, secret-free mqttthing export, and MQTT command/state/reconnect flows against an in-process MQTT 3.1.1 broker with a fake Tuya cloud. They do not establish live QR service availability or compatibility with a particular physical blind. Validate QR authorization, opening direction, intermediate positions, stop, physical/app changes and reconnect behavior with your actual account/device before relying on it.

The Docker image has been built and the Compose service smoke-tested locally, including its HTTP health check and persistent data volume. Building/running the container requires a running Docker engine. Tagged releases publish multi-platform images to `ghcr.io/nishantapatil3/tuya-mqtt`.

## Logging

The service writes JSON log lines with UTC timestamps, level, component scope, event and details. Startup, account linking, discovery, configuration saves, state changes, commands and failures are logged at `info` or above. `debug` also includes HTTP requests, cloud request timings, approval polling, MQTT topics and each device poll. Browser console messages identify setup requests without logging their bodies. Credentials, account User Codes, QR tokens, session tokens and MQTT URL credentials are redacted.

```sh
# Detailed logging, including cloud/MQTT/poll activity
LOG_LEVEL=debug docker compose up -d
docker compose logs -f tuya-mqtt
```

Levels: `debug`, `info` (default), `warn`, `error`, `silent`. For Node, use `LOG_LEVEL=debug npm start`. Compose rotates logs at 10 MB per file and retains three files. The private data volume is separate from logs.
