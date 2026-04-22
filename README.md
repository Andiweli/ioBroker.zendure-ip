<p align="center">
  <img src="admin/zendure-ip.png" alt="Zendure IP logo" width="120" />
</p>

<h1 align="center">Zendure IP</h1>

<p align="center">
  Local Zendure polling adapter for ioBroker with optional HEMS aggregation.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.8-00a17f.svg" alt="Version 0.0.8" />
  <img src="https://img.shields.io/badge/language-JavaScript-00a17f.svg?logo=javascript&logoColor=fff" alt="JavaScript" />
  <img src="https://img.shields.io/badge/license-MIT-00a17f.svg" alt="MIT License" />
</p>

> [!IMPORTANT]
> This adapter polls Zendure devices locally via `http://<ip>/properties/report` and stores a curated state set instead of dumping the full raw JSON.

> [!NOTE]
> This adapter is **read-only**. It does not control Zendure devices; it reads data and generates daily counters.  
> For full control features, the recommended adapter is [nograx' Zendure adapter](https://github.com/nograx/ioBroker.zendure-solarflow).

## <img src="icons/features.svg" width="18" alt="" /> Features

- Poll up to **10 Zendure devices** locally
- Device name becomes the folder name under the adapter namespace
- Spaces in device names are converted to `-`
- Curated device states based on the provided per-device script set
- Optional **HEMS** object tree for devices marked with **Device is in HEMS**
- Per-device daily counters under `device-name/today`
- Aggregated daily counters under `HEMS/today`

## <img src="icons/devices.svg" width="18" alt="" /> Device objects

Each device gets a compact state set such as:

- `product`, `serial`, `messageId`, `timestamp`
- `soc`
- `acPowerW`, `acDirectionW`, `acChargingW`, `acDischargingW`
- `solarInputPower`, `solarPower1..4`
- `outputPackPower`, `packInputPower`, `outputHomePower`, `gridInputPower`
- `minSocPct`, `socSetPct`
- `packNum`
- `online`, `lastUpdate`, `ageSec`, `stale`, `rssi`, `lastError`, `rawJson`
- `deviceIsInHems`

## <img src="icons/daily.svg" width="18" alt="" /> Daily counters

### <img src="icons/device-day.svg" width="17" alt="" /> Per device

Under `device-name/today`:

- `acImportTodayKWh`
- `acExportTodayKWh`
- for `2400pro` also `pvToBatteryTodayKWh`

### <img src="icons/hems.svg" width="17" alt="" /> HEMS aggregate

Under `HEMS/today`:

- `acImportTodayKWh`
- `acExportTodayKWh`
- `pvToBatteryTodayKWh`

## <img src="icons/config.svg" width="18" alt="" /> Configuration

The adapter configuration page is intentionally small:

- **Device name**
- **IP address**
- **Interval (s)**
- **Device is in HEMS**

## <img src="icons/notes.svg" width="18" alt="" /> Notes

- The adapter is designed for **local readout only**
- No write/control commands are sent to Zendure devices
- For an even more detailed adapter including control of your Zendure devices, please use the [Zendure SolarFlow Adapter from nograx](https://github.com/nograx/ioBroker.zendure-solarflow).

## <img src="icons/license.svg" width="18" alt="" /> License

This project is licensed under the **MIT License**.

You may use, modify, and distribute this software in private and commercial environments, provided that the original copyright notice and license text are included in any substantial portions of the software.

The software is provided **"as is"**, without warranty of any kind.

Copyright (c) 2025 Andreas Stürmer
