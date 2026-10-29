# Configuration

[Back to README](../README.md) · [Setup](setup.md) · [MQTT reference](mqtt.md)

See [config.example.json](../config.example.json) for a developer-project configuration, or use the setup page for QR login. Environment variables are listed in [Setup](setup.md#start-with-nodejs).

## v0.1 scope

- Window blinds with open, close, stop and percentage targets.
- Real position feedback, accepted targets, measured movement direction and availability.
- Configurable Tuya codes, percentage direction, numeric ranges and string targets.
- Startup synchronization, broker reconnects, token renewal and bounded polling backoff.
- User Code + QR login, persistent sessions, browser setup, device inspection and mqttthing export.
- Graceful shutdown and MQTT last-will availability for unexpected disconnects.

This release uses **cloud polling**, not Tuya message-service push. Changes made in Smart Life or using physical controls appear on the next normal poll. It does not provide local LAN control, tilt, travel-time estimates, or support for blinds without actual position feedback. A successful command never becomes a fabricated current-position reading.

## Window blind mappings

The default codes are `percent_state` for observed position, `percent_control` for a requested position, and `control` with `open`, `close`, `stop`. These are common values, **not a guarantee for every Tuya blind**. Use inspection to confirm the actual schema. Startup validates configured codes, target type, target range and enum commands before accepting motor commands.

| Device option | Default | Meaning |
| --- | --- | --- |
| `type` | `blind` | Only window blinds are supported; may be omitted in existing configurations |
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
| `motionPollSeconds` | `1` | Interval following an accepted command, minimum 1 second |
| `motionTimeoutSeconds` | `60` | Motion tracking timeout; adjust for travel time |

Polling runs serially per blind, without overlapping that blind's commands. After each accepted blind command, fast polling continues for at least 20 seconds, even if the requested position or a stop is confirmed immediately. Each new command restarts this window. Pending movement continues fast polling until the requested position is observed or the motion timeout expires; then the normal idle interval resumes once the 20-second window has also elapsed. A stop reconciles the target to the next observed position. Timeouts do not cause motor commands to be automatically replayed. Explicit token-rejection errors renew authentication and retry once.

Supported region keys: `us` (Western America), `us-east`, `eu` (Central Europe), `eu-west`, `cn`, `in`, `sg`. See [Tuya's endpoint reference](https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4).
