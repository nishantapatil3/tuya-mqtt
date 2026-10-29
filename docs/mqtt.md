# MQTT reference

[Back to README](../README.md) · [Configuration](configuration.md)

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
