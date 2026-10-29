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
| `positionMin`, `positionMax` | `0`, `100` | Raw reported position range; also the target range unless overridden |
| `targetMin`, `targetMax` | Position range | Separate writable target range, when different from feedback |
| `targetStep` | `1` | Writable target step; targets round to the nearest supported step |
| `targetAsString` | `false` | Enable for string-valued target codes, such as some legacy `position` codes |
| `workStateCode` | Omitted | Optional actual motion feedback code, e.g. `work_state` |
| `openingValue`, `closingValue`, `stoppedValue` | `opening`, `closing`, `stopped` | Values for explicit physical movement state |

HomeKit and MQTT always use **0 = closed, 100 = open**, regardless of the raw device range. Open/close enum values describe physical actions and are not swapped by percentage inversion. Target commands are rounded to the configured step, and the accepted HomeKit/MQTT target reflects that attainable position. For example, with a 0–100 target range and step 5, requesting 53% sends 55 and tracks 55%. Range endpoints must align with the step. Existing configurations keep their shared range and step 1 defaults.

Discovery recognizes single-channel curtain (`cl`), curtain-switch (`clkg`) and window-controller (`mc`) devices with readable percentage feedback. It checks `control`/`mach_operate`, `percent_control`/`position`, and known open/close/stop variants including `opening`/`closing` and `ZZ`/`FZ`/`STOP`. A compatible `work_state` enum is mapped automatically. Range and step metadata are used when available; missing position range metadata falls back to the target range. Existing saved mappings are not replaced automatically; rediscover and review before saving to use new suggestions.

Percentage inversion remains an explicit setting: command history and motor direction do not reliably prove percentage direction. Discovery does not select a shared writable `position` datapoint as measured feedback automatically; use an explicit mapping only after verifying it reports real position. Multi-channel controllers, tilt and control-only devices without position feedback remain outside this release's scope.

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

Polling runs serially per blind, without overlapping that blind's commands. After each accepted blind command, fast polling continues for at least 20 seconds, even if the requested position or a stop is confirmed immediately. Each new command restarts this window. Pending movement continues fast polling until the requested position is observed or the motion timeout expires; then the normal idle interval resumes once the 20-second window has also elapsed. A stop follows subsequent position readings until motion reports stopped (or its tracking timeout expires), so a delayed final reading can update the stopped target. A physical/app stop reported by a configured motion datapoint after observed movement also clears a pending target. At an open/closed endpoint, a stale motion value pointing toward that endpoint is treated as stopped; this sends no extra motor commands. Timeouts do not cause motor commands to be automatically replayed. Explicit token-rejection errors renew authentication and retry once.

Movement detected from the app or physical controls starts a bounded fast-poll window of `motionTimeoutSeconds`. Detection still waits for the next scheduled cloud read. A continuously stuck motion value does not restart this window. While external movement is observed, a target behind the direction of travel is ignored in favor of the corresponding endpoint; once stopped, target returns to measured position.

Supported region keys: `us` (Western America), `us-east`, `eu` (Central Europe), `eu-west`, `cn`, `in`, `sg`. See [Tuya's endpoint reference](https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4).

## Curtain handling reference

Command aliases and motion-state handling were informed by [homebridge-tuya's curtain implementation](https://github.com/homebridge-plugins/homebridge-tuya/blob/latest/src/accessory/WindowCoveringAccessory.ts) and its [position states](https://github.com/homebridge-plugins/homebridge-tuya/blob/latest/src/accessory/characteristic/PositionState.ts). This bridge keeps independent QR authentication, cloud polling, explicit percentage inversion and confirmed position feedback. It does not simulate position or send automatic stop commands from a read handler.
