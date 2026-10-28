# tuya-mqtt

Tuya Cloud → MQTT bridge for your devices, with a local setup page and generated [Homebridge mqttthing](https://github.com/arachnetech/homebridge-mqttthing) accessories. Written in TypeScript on Node.js. Inspired by the standalone service and Docker workflows in [dyson-mqtt](https://github.com/nishantapatil3/dyson-mqtt) and [ring-mqtt](https://github.com/tsightler/ring-mqtt).

```text
Apple Home ↔ Homebridge mqttthing ↔ Your MQTT broker ↔ tuya-mqtt ↔ Tuya Cloud
```

## Supported devices

- **Window blinds** — open, close, stop and percentage positioning, with reported position feedback.

Window blinds are the only supported device type for now. The setup interface uses generic device labels so additional device types can be added later.

## v0.1 scope

- Multiple blinds, with open, close, stop and percentage targets.
- Real position feedback, accepted targets, measured movement direction and availability.
- Configurable Tuya codes, percentage direction, numeric ranges and string targets.
- Startup synchronization, broker reconnects, token renewal and bounded polling backoff.
- User Code + QR login, persistent sessions, browser setup, device inspection and mqttthing export.
- Graceful shutdown and MQTT last-will availability for unexpected disconnects.

This release uses **cloud polling**, not Tuya message-service push. Changes made in Smart Life or using physical controls appear on the next normal poll. It does not provide local LAN control, tilt, travel-time estimates, or support for blinds without actual position feedback. A successful command never becomes a fabricated current-position reading.

## Requirements

1. Blinds already working in Tuya Smart or Smart Life.
2. **Recommended: your app's User Code and a QR scan.** Find the User Code under **Me → Settings → Account and Security → User Code**. This is different from a developer-project UID. A developer account, Access ID/Secret and manual data-center selection are not required for this login. See [Home Assistant's Tuya onboarding](https://www.home-assistant.io/integrations/tuya/).
3. An accessible MQTT broker, such as Mosquitto. This bridge does not include a broker.
4. Homebridge with mqttthing installed.

The advanced **Developer cloud project** option remains supported: link your app account to a [Tuya cloud project](https://developer.tuya.com/en/docs/iot/smart-home-quick-start?id=Kbvwrxn6mngbd), authorize device information/specification/control APIs, and enter its data center and Access ID/Secret. An app-account UID can list devices in this mode. Developer-project API access can [expire or be restricted by quotas](https://support.tuya.com/en/help/_detail/Kam16w82cm0hw).

Both login modes still use cloud polling. At 60 seconds, each blind uses about **43,200 normal device reads per 30 days**, plus startup specification reads, token requests, commands and motion polling. Choose an appropriate interval for your account and device count; QR login is not a promise of unlimited API usage. Poll failures mark the affected blind unavailable and back off up to 15 minutes.

### About QR authorization

The TypeScript implementation follows Tuya's official [device-sharing SDK protocol](https://github.com/tuya/tuya-device-sharing-sdk), including encrypted requests and token renewal. By default it uses the public app registration used by Home Assistant (`HA_3y9q4ak7g4ephrvke`, schema `haauthorize`). **Tuya's authorization screen may identify the app as Home Assistant.** This project is independent of Home Assistant. A successful scan grants the device-sharing access allowed by Tuya; the bridge only sends commands to your configured blinds.

Tuya can change or restrict this registration/flow. For a separately registered integration, set `TUYA_SHARING_CLIENT_ID` and `TUYA_SHARING_SCHEMA` to values issued by Tuya. This is a different API from the developer-project OpenAPI: QR tokens cannot simply be substituted for an Access ID/Secret.

The session is stored in `sharing-session.json` beside your config, with private file permissions. Access and refresh tokens stay on the server; setup does not return them to the browser. Tokens renew automatically and are saved after rotation. If a session expires or is revoked, generate and approve a new QR code. Setup checks for approval automatically for up to three minutes. An already-approved login can still be claimed with the connect button after that local deadline if Tuya accepts it; unapproved codes may expire sooner on Tuya's side. No account password is requested.

## Start with Docker

```sh
docker compose up -d --build
```

Open [localhost:3200](http://localhost:3200). Configuration is persisted in the `tuya-data` Docker volume. The container runs as the unprivileged `node` user.

Compose builds the local `tuya-mqtt:local` image from the multi-stage `Dockerfile`. The final image contains compiled code and production dependencies; local credentials, sessions, screenshots and development files are excluded. The container has a read-only application filesystem, a writable data volume, and an HTTP health check. The health check confirms setup-page availability; cloud and MQTT connectivity are shown separately in bridge status.

Useful commands:

```sh
docker compose logs -f tuya-mqtt
docker compose restart
docker compose down
```

`docker compose down` preserves the data volume. To rebuild after updating the source, run `docker compose up -d --build` again. To use a different local port, run `TUYA_MQTT_WEB_PORT=3201 docker compose up -d` and open localhost:3201. Stop any earlier Node process using port 3200 before starting Compose on that port.

1. Leave **User Code + QR code** selected, enter your app's User Code, and select **Generate QR code**.
2. In Smart Life or Tuya Smart tap **+ → Scan**, scan the displayed code and approve. Setup detects approval automatically; **I've approved it — connect** can also check immediately. The bridge lists devices and selects recognized compatible blinds. This does not move them. On later visits, the saved session automatically loads the device list; **Inspect devices** refreshes it.
3. Enter your MQTT broker URL, review the selected blinds, and save. If your blind is not recognized, inspect the returned capabilities and adjust mappings in the configuration file; only `cl` and `clkg` devices with recognized position and control schemas receive automatic suggestions. Verify percentage direction with one blind before configuring the rest.
4. Refresh status. A blind becomes online after its mappings validate and its first position read succeeds.
5. Copy the generated mqttthing accessory objects into Homebridge's `accessories` array and restart Homebridge. Replace MQTT credential placeholders if present. The broker address must be reachable from Homebridge too.

Inside Docker, `localhost` refers to the container. For a broker on the host, use `mqtt://host.docker.internal:1883`; for another Compose service use its service name on a shared network.

The example exposes setup on the Docker host's loopback address. To access it from your LAN, change the Compose port mapping to `3200:3200`. There is no setup-page login; use a trusted home network and do not expose the port to the Internet. Setup accepts localhost, private IP addresses and `.local` hostnames. Mutating requests require the page's session token and a matching origin. Saved secrets are never returned to the browser. Configuration saves replace previous settings; a saved QR session can be reused without rescanning. Developer credentials must be re-entered when reconfiguring that mode.

### Moving an existing Node installation into Docker

The local `data/` folder is not baked into the image. To reuse an existing login and configuration, start Compose, copy the existing files into its volume, set their container ownership, and restart:

```sh
docker compose up -d
docker compose cp ./data/config.json tuya-mqtt:/app/data/config.json
docker compose cp ./data/sharing-session.json tuya-mqtt:/app/data/sharing-session.json
docker compose exec --user root tuya-mqtt chown node:node /app/data/config.json /app/data/sharing-session.json
docker compose exec --user root tuya-mqtt chmod 600 /app/data/config.json /app/data/sharing-session.json
docker compose restart
```

Only copy files that exist; developer-project setups do not need `sharing-session.json`. These steps replace files in the container volume, so use them only to import the intended saved configuration. In the imported config, replace a broker address of `localhost` or `127.0.0.1` with `host.docker.internal` if that broker runs on the Docker host.

## Start with Node.js

Use Node.js 22 or later:

```sh
npm ci
npm run build
npm start
```

Setup defaults to `http://127.0.0.1:3200`, and config defaults to `./data/config.json`. Use the browser for QR login. For manual **developer-project** configuration, copy `config.example.json` to `data/config.json`, fill in the values, and restart. Use `mkdir -p data` first. Keep the config and session files private: they contain account credentials and may contain an MQTT password.

```sh
# Optional: inspect configured devices without starting the bridge
npm run inspect
```

| Environment variable | Purpose |
| --- | --- |
| `TUYA_MQTT_CONFIG` | Config file path |
| `TUYA_MQTT_HOST` | Setup bind address; Node default `127.0.0.1`, container `0.0.0.0` |
| `TUYA_MQTT_PORT` | Setup port; default `3200` |
| `TUYA_ACCESS_ID` / `TUYA_ACCESS_SECRET` | Override saved cloud credentials when starting the bridge |
| `MQTT_URL` | Override the saved broker URL when starting the bridge |
| `TUYA_MQTT_SESSION` | Override the QR session path; default `sharing-session.json` beside config |
| `TUYA_SHARING_CLIENT_ID` / `TUYA_SHARING_SCHEMA` | Optional Tuya-issued device-sharing app registration |

Developer-mode inspection uses the credentials entered in its form. QR-mode inspection uses the saved session. Restart the service after manually editing its configuration file.

## Device mappings

The default codes are `percent_state` for observed position, `percent_control` for a requested position, and `control` with `open`, `close`, `stop`. These are common values, **not a guarantee for every Tuya blind**. Use inspection to confirm the actual schema. Startup validates configured codes, target type, target range and enum commands before accepting motor commands.

| Device option | Default | Meaning |
| --- | --- | --- |
| `id`, `name` | Required | Tuya device ID and Homebridge display name |
| `topic` | Device ID | Stable topic segment; letters, digits, `_`, `-` |
| `positionCode` | `percent_state` | Actual reported position, not just a writable command echo |
| `targetCode` | `percent_control` | Writable target position |
| `controlCode` | `control` | Writable open/close/stop enum |
| `openValue`, `closeValue`, `stopValue` | `open`, `close`, `stop` | Enum values from inspection |
| `invertPosition` | `false` | Set true when Tuya's maximum means fully closed |
| `positionMin`, `positionMax` | `0`, `100` | Raw device range used by both position and target |
| `targetAsString` | `false` | Enable for string-valued target codes, such as some legacy `position` codes |
| `workStateCode` | Omitted | Optional actual motion feedback code, e.g. `work_state` |
| `openingValue`, `closingValue`, `stoppedValue` | `opening`, `closing`, `stopped` | Values for explicit physical movement state |

HomeKit and MQTT always use **0 = closed, 100 = open**, regardless of the raw device range. Open/close enum values describe physical actions and are not swapped by percentage inversion. Separate current and target ranges and integer targets with a step greater than 1 are not supported in v0.1.

Without `workStateCode`, direction is inferred from successive position readings and STOPPED means no observed position change. This is sampled movement, not an instantaneous motor-state guarantee. Set a work-state mapping when the device provides reliable movement feedback. Battery blinds that only report after travel may remain STOPPED until the next reading.

| Global option | Default | Meaning |
| --- | --- | --- |
| `topicPrefix` | `tuya` | MQTT root |
| `authMode` | `cloud` for legacy files | `sharing` uses the saved QR session; `cloud` requires `tuyaCloud` |
| `clientId` | `tuya-mqtt` | Must be unique per bridge instance |
| `mqttProtocolVersion` | `4` | MQTT 3.1.1; set `5` for MQTT 5 brokers |
| `pollIntervalSeconds` | `60` | Normal interval, minimum 10 seconds |
| `motionPollSeconds` | `5` | Interval following an accepted command, minimum 2 seconds |
| `motionTimeoutSeconds` | `60` | Maximum fast-poll period; adjust for travel time |

Polling runs serially per blind, without overlapping that blind's commands. Fast polling ends once the requested position is observed or the motion period expires. A stop reconciles the target to the next observed position. Timeouts do not cause motor commands to be automatically replayed. Explicit token-rejection errors renew authentication and retry once.

Supported region keys: `us` (Western America), `us-east`, `eu` (Central Europe), `eu-west`, `cn`, `in`, `sg`. See [Tuya's endpoint reference](https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4).

## MQTT contract

For `topicPrefix: "tuya"`, `topic: "living-room"`:

| Topic | Payload | Retained |
| --- | --- | --- |
| `tuya/living-room/target/set` | Integer `0`–`100` | **Never** |
| `tuya/living-room/command/set` | `OPEN`, `CLOSE`, `STOP` | **Never** |
| `tuya/living-room/hold/set` | `true` or `1` stops; `false` or `0` is ignored | **Never** |
| `tuya/living-room/position` | Confirmed integer `0`–`100` | Yes |
| `tuya/living-room/target` | Last accepted or reported target `0`–`100` | Yes |
| `tuya/living-room/position_state` | `INCREASING`, `DECREASING`, `STOPPED` | Yes |
| `tuya/living-room/availability` | `online`, `offline` | Yes |
| `tuya/living-room/error` | Brief command error | No |
| `tuya/status` | `{"online":true,"devices":{"DEVICE_ID":true}}` | Yes |

The `tuya/status` last will is `{"online":false,"devices":{}}`. Consumers must combine bridge and device availability; an individual retained device topic cannot reflect a crashed bridge by itself. The generated mqttthing configuration handles both using the combined status topic.

Retained commands delivered on subscription are ignored. Under MQTT 5, retain-as-published also rejects live retained commands. Under MQTT 3.1.1, a live retained publish can be indistinguishable from a normal command and may execute once. Always publish command topics without retain, including in mqttthing. Remove old retained command messages from your broker.

To exercise a configured blind manually (these commands move it):

```sh
mosquitto_pub -h YOUR_BROKER -t tuya/living-room/target/set -m 50
mosquitto_pub -h YOUR_BROKER -t tuya/living-room/command/set -m STOP
```

## Development and verification

```sh
npm run check
npm test
npm run build
docker compose config --quiet
```

Tests cover QR challenge lifecycle, endpoint validation, AES-GCM interoperability, encrypted sharing requests, token rotation, legacy request signing, conversions, mapping validation, secret-free mqttthing export, and MQTT command/state/reconnect flows against an in-process MQTT 3.1.1 broker with a fake Tuya cloud. They do not establish live QR service availability or compatibility with a particular physical blind. Validate QR authorization, opening direction, intermediate positions, stop, physical/app changes and reconnect behavior with your actual account/device before relying on it.

The Docker image has been built and the Compose service smoke-tested locally, including its HTTP health check and persistent data volume. Building/running the container requires a running Docker engine. No container image is published by this project yet.
