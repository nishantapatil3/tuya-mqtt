# tuya-mqtt

Tuya Cloud → MQTT bridge with QR login, a local setup page, and generated [Homebridge mqttthing](https://github.com/arachnetech/homebridge-mqttthing) configuration.

```text
Apple Home ↔ Homebridge mqttthing ↔ MQTT broker ↔ tuya-mqtt ↔ Tuya Cloud
```

## Supported devices

- **Window blinds** — open, close, stop, and percentage positioning with real position feedback.
- **Watering pumps** — on/off control, reported state, and timed watering through Homebridge.

Uses Tuya Cloud polling; an internet connection is required.

## Quick start

You need Docker Compose, an MQTT broker, and devices paired in Smart Life or Tuya Smart. For Apple Home, install Homebridge and mqttthing.

```sh
git clone https://github.com/nishantapatil3/tuya-mqtt.git
cd tuya-mqtt
docker compose up -d --build
```

1. Open [localhost:3200](http://localhost:3200).
2. Enter your app's **User Code** from **Me → Settings → Account and Security**, then generate and scan the QR code. No developer credentials are needed; [QR authorization details](docs/setup.md#about-qr-authorization).
3. Select your devices, enter your MQTT broker URL, and save.
4. Copy the generated accessories into Homebridge's `accessories` array.

For a broker on the Docker host, use `mqtt://host.docker.internal:1883`. Your settings and login persist in a Docker volume. Keep the setup page on a trusted network.

## Documentation

- [Setup](docs/setup.md) — QR login, Docker, Node.js, migration, and connection troubleshooting.
- [Configuration](docs/configuration.md) — device mappings, polling, and supported capabilities.
- [MQTT reference](docs/mqtt.md) — topics, payloads, and availability.
- [Development](docs/development.md) — checks and testing.

Inspired by [dyson-mqtt](https://github.com/nishantapatil3/dyson-mqtt) and [ring-mqtt](https://github.com/tsightler/ring-mqtt).
