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

The Docker image has been built and the Compose service smoke-tested locally, including its HTTP health check and persistent data volume. Building/running the container requires a running Docker engine. No container image is published by this project yet.
