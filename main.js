"use strict";

const utils = require("@iobroker/adapter-core");
const http = require("http");

const DEFAULT_INTERVAL_SEC = 10;
const STALE_AFTER_SEC = 45;
const ZERO_POWER_AFTER_SEC = 60;
const WATCHDOG_MS = 5000;
const HTTP_TIMEOUT_MS = 6000;
const HEMS_DEADBAND_W = 30;
const PV_NOISE_W = 5;

class ZendureIpAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "zendure-ip",
        });

        this.pollTimers = new Map();
        this.watchdogTimer = null;
        this.devices = [];
        this.objectCache = new Set();
        this.energyLastTs = Date.now();

        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    sanitizeName(name, fallback) {
        const src = String(name || fallback || "device").trim();
        const withDashes = src.replace(/\s+/g, "-");
        const cleaned = withDashes.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
        return cleaned || fallback || "device";
    }

    uniqueDeviceIds(devices) {
        const used = new Set();
        return devices.map((device, index) => {
            const baseId = this.sanitizeName(device.name, `device-${index + 1}`);
            let candidate = baseId;
            let n = 2;
            while (used.has(candidate)) candidate = `${baseId}-${n++}`;
            used.add(candidate);
            return candidate;
        });
    }

    safeNum(v, fallback = 0) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    toPctScaledBy10(raw) {
        return Math.round((this.safeNum(raw, 0) / 10) * 10) / 10;
    }

    clipRaw(obj, maxLen = 2000) {
        try {
            const s = JSON.stringify(obj);
            return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
        } catch {
            return "";
        }
    }

    todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    stateNum(val, fallback = 0) {
        const n = Number(val);
        return Number.isFinite(n) ? n : fallback;
    }

    async getStateNum(id, fallback = 0) {
        return this.stateNum((await this.getStateAsync(id))?.val, fallback);
    }

    async addWhAndUpdateKWh(whId, kwhId, addWh) {
        const curWh = await this.getStateNum(whId, 0);
        const nextWh = curWh + addWh;
        const nextWhRounded = Math.round(nextWh * 100) / 100;
        await this.setStateChangedAsync(whId, { val: nextWhRounded, ack: true });
        const nextKWhRounded = Math.round((nextWhRounded / 1000) * 1000) / 1000;
        await this.setStateChangedAsync(kwhId, { val: nextKWhRounded, ack: true });
    }

    async onReady() {
        this.log.info("Starting zendure-ip adapter");

        const configured = Array.isArray(this.config.devices) ? this.config.devices.slice(0, 10) : [];
        const devices = configured.filter(d => d && d.ip && String(d.ip).trim());

        if (!devices.length) {
            this.log.warn("No devices configured.");
            return;
        }

        const ids = this.uniqueDeviceIds(devices);
        this.devices = devices.map((device, index) => ({
            id: ids[index],
            name: String(device.name || ids[index]).trim(),
            ip: String(device.ip).trim(),
            intervalSec: Number(device.intervalSec) > 0 ? Number(device.intervalSec) : DEFAULT_INTERVAL_SEC,
            isInHems: !!device.isInHems,
            inFlight: false,
            type: 'ac',
            capKWh: 2.4,
        }));

        for (const dev of this.devices) {
            await this.ensureDeviceObjects(dev);
            await this.ensureDeviceTodayObjects(dev);
        }

        if (this.devices.some(d => d.isInHems)) {
            await this.ensureHemsObjects();
            await this.ensureHemsTodayObjects();
        }

        // Initial poll first so pro-specific today objects exist even at night.
        for (const dev of this.devices) {
            await this.pollDevice(dev);
        }

        await this.maybeResetTodayCounters();

        for (const dev of this.devices) {
            const pollFn = async () => this.pollDevice(dev);
            const timer = this.setInterval(() => void pollFn(), dev.intervalSec * 1000);
            this.pollTimers.set(dev.id, timer);
        }

        this.energyLastTs = Date.now();

        this.watchdogTimer = this.setInterval(async () => {
            await this.runWatchdogAndHems();
        }, WATCHDOG_MS);

        await this.runWatchdogAndHems();
    }

    async onUnload(callback) {
        try {
            for (const timer of this.pollTimers.values()) this.clearInterval(timer);
            this.pollTimers.clear();
            if (this.watchdogTimer) {
                this.clearInterval(this.watchdogTimer);
                this.watchdogTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    fetchJson(ip) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: ip,
                port: 80,
                path: "/properties/report",
                method: "GET",
                headers: { Accept: "application/json" },
                timeout: HTTP_TIMEOUT_MS,
            }, res => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error("JSON parse failed"));
                    }
                });
            });

            req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
            req.on("error", reject);
            req.end();
        });
    }

    async pollDevice(dev) {
        if (dev.inFlight) return;
        dev.inFlight = true;

        try {
            const json = await this.fetchJson(dev.ip);
            const p = json.properties || {};
            const now = Date.now();
            const product = String(json.product || "");
            const packNum = this.safeNum(p.packNum, 0);
            const isPro = /2400pro/i.test(product) || packNum > 1;

            if (isPro) {
                await this.ensureDeviceProTodayObjects(dev.id);
            }

            const mapped = {
                soc: this.safeNum(p.electricLevel, 0),
                acChargingW: this.safeNum(p.gridInputPower, 0),
                acDischargingW: this.safeNum(p.outputHomePower, 0),
                acDirectionW: this.safeNum(p.outputHomePower, 0) - this.safeNum(p.gridInputPower, 0),
                acPowerW: Math.max(this.safeNum(p.gridInputPower, 0), this.safeNum(p.outputHomePower, 0)),

                solarInputPower: this.safeNum(p.solarInputPower, 0),
                solarPower1: this.safeNum(p.solarPower1, 0),
                solarPower2: this.safeNum(p.solarPower2, 0),
                solarPower3: this.safeNum(p.solarPower3, 0),
                solarPower4: this.safeNum(p.solarPower4, 0),

                outputPackPower: this.safeNum(p.outputPackPower, 0),
                packInputPower: this.safeNum(p.packInputPower, 0),

                minSocPct: this.toPctScaledBy10(p.minSoc),
                socSetPct: this.toPctScaledBy10(p.socSet),

                rssi: this.safeNum(p.rssi, 0),
                online: true,
                lastUpdate: now,
                rawJson: this.clipRaw(json),
            };

            // device capabilities inferred from current JSON
            dev.type = isPro ? "pro" : "ac";
            if (isPro) {
                const packType = this.safeNum((json.packData && json.packData[0] && json.packData[0].packType) || 0, 0);
                // Fallback to 7.4 kWh like the user's current setup if we cannot infer better.
                dev.capKWh = packNum > 1 ? 7.4 : (packType === 300 ? 2.0 : 2.4);
            } else {
                const productLc = product.toLowerCase();
                dev.capKWh = productLc.includes('1600') ? 2.0 : 2.4;
            }

            for (const [key, val] of Object.entries(mapped)) {
                await this.setStateChangedAsync(`${dev.id}.${key}`, { val, ack: true });
            }
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            this.log.warn(`Device ${dev.id} (${dev.ip}) poll failed: ${msg}`);
            await this.setStateChangedAsync(`${dev.id}.online`, { val: false, ack: true });
        } finally {
            dev.inFlight = false;
        }
    }

    async runWatchdogAndHems() {
        const now = Date.now();
        let dtSec = (now - this.energyLastTs) / 1000;
        if (!Number.isFinite(dtSec) || dtSec <= 0) dtSec = WATCHDOG_MS / 1000;
        if (dtSec > 60) dtSec = WATCHDOG_MS / 1000;
        this.energyLastTs = now;

        await this.maybeResetTodayCounters();

        for (const dev of this.devices) {
            const base = dev.id;
            const last = this.safeNum((await this.getStateAsync(`${base}.lastUpdate`))?.val, 0);
            const ageSec = last ? Math.floor((now - last) / 1000) : 999999;
            const stale = ageSec >= STALE_AFTER_SEC;

            await this.setStateChangedAsync(`${base}.ageSec`, { val: ageSec, ack: true });
            await this.setStateChangedAsync(`${base}.stale`, { val: stale, ack: true });

            if (ageSec >= ZERO_POWER_AFTER_SEC) {
                const zeroStates = [
                    "acChargingW", "acDischargingW", "acDirectionW", "acPowerW",
                    "solarInputPower", "solarPower1", "solarPower2", "solarPower3", "solarPower4",
                    "outputPackPower", "packInputPower", "outputHomePower", "gridInputPower"
                ];
                for (const state of zeroStates) {
                    await this.setStateChangedAsync(`${base}.${state}`, { val: 0, ack: true });
                }
            }
        }

        await this.updateTodayCounters(dtSec);
        await this.updateHems();
    }

    async maybeResetTodayCounters() {
        const today = this.todayStr();

        for (const dev of this.devices) {
            const base = `${dev.id}.today`;
            const lastReset = String((await this.getStateAsync(`${base}.lastResetDate`))?.val || "");
            if (lastReset !== today) {
                await this.resetDeviceToday(dev.id, today);
            }
        }

        if (this.devices.some(d => d.isInHems)) {
            const base = `HEMS.today`;
            const lastReset = String((await this.getStateAsync(`${base}.lastResetDate`))?.val || "");
            if (lastReset !== today) {
                await this.resetHemsToday(today);
            }
        }
    }

    async resetDeviceToday(deviceId, today) {
        const prefix = `${deviceId}.today`;
        const zeroStates = [
            "acImportTodayWh",
            "acImportTodayKWh",
            "acExportTodayWh",
            "acExportTodayKWh",
            "pvToBatteryTodayWh",
            "pvToBatteryTodayKWh",
            "pvTodayWh",
            "pvTodayKWh"
        ];
        for (const state of zeroStates) {
            if (this.objectCache.has(`state:${prefix}.${state}`)) {
                await this.setStateChangedAsync(`${prefix}.${state}`, { val: 0, ack: true });
            }
        }
        await this.setStateChangedAsync(`${prefix}.lastResetDate`, { val: today, ack: true });
    }

    async resetHemsToday(today) {
        const prefix = `HEMS.today`;
        const zeroStates = [
            "acImportTodayWh",
            "acImportTodayKWh",
            "acExportTodayWh",
            "acExportTodayKWh",
            "pvToBatteryTodayWh",
            "pvToBatteryTodayKWh",
            "pvTodayWh",
            "pvTodayKWh"
        ];
        for (const state of zeroStates) {
            await this.setStateChangedAsync(`${prefix}.${state}`, { val: 0, ack: true });
        }
        await this.setStateChangedAsync(`${prefix}.lastResetDate`, { val: today, ack: true });
    }

    async updateTodayCounters(dtSec) {
        let hemsImportWhAdd = 0;
        let hemsExportWhAdd = 0;
        let hemsPvToBatteryWhAdd = 0;
        let hemsPvWhAdd = 0;

        for (const dev of this.devices) {
            const id = dev.id;
            const online = !!(await this.getStateAsync(`${id}.online`))?.val;
            const stale = !!(await this.getStateAsync(`${id}.stale`))?.val;
            const active = online && !stale;

            const acChargingW = active ? Math.max(0, await this.getStateNum(`${id}.acChargingW`, 0)) : 0;
            const acDischargingW = active ? Math.max(0, await this.getStateNum(`${id}.acDischargingW`, 0)) : 0;
            const solarInputPower = active ? Math.max(0, await this.getStateNum(`${id}.solarInputPower`, 0)) : 0;
            const outputPackPower = active ? Math.max(0, await this.getStateNum(`${id}.outputPackPower`, 0)) : 0;

            const addImportWh = acChargingW * (dtSec / 3600);
            const addExportWh = acDischargingW * (dtSec / 3600);

            await this.addWhAndUpdateKWh(`${id}.today.acImportTodayWh`, `${id}.today.acImportTodayKWh`, addImportWh);
            await this.addWhAndUpdateKWh(`${id}.today.acExportTodayWh`, `${id}.today.acExportTodayKWh`, addExportWh);

            let pvToBatteryWhAdd = 0;
            if (this.objectCache.has(`state:${id}.today.pvToBatteryTodayKWh`)) {
                const pvToBatteryW = solarInputPower > PV_NOISE_W ? Math.min(outputPackPower, solarInputPower) : 0;
                pvToBatteryWhAdd = pvToBatteryW * (dtSec / 3600);
                await this.addWhAndUpdateKWh(`${id}.today.pvToBatteryTodayWh`, `${id}.today.pvToBatteryTodayKWh`, pvToBatteryWhAdd);
            }

            if (this.objectCache.has(`state:${id}.today.pvTodayKWh`)) {
                const pvWhAdd = solarInputPower * (dtSec / 3600);
                await this.addWhAndUpdateKWh(`${id}.today.pvTodayWh`, `${id}.today.pvTodayKWh`, pvWhAdd);
            }

            if (dev.isInHems) {
                hemsImportWhAdd += addImportWh;
                hemsExportWhAdd += addExportWh;
                hemsPvToBatteryWhAdd += pvToBatteryWhAdd;
                hemsPvWhAdd += solarInputPower * (dtSec / 3600);
            }
        }

        if (this.devices.some(d => d.isInHems)) {
            await this.addWhAndUpdateKWh(`HEMS.today.acImportTodayWh`, `HEMS.today.acImportTodayKWh`, hemsImportWhAdd);
            await this.addWhAndUpdateKWh(`HEMS.today.acExportTodayWh`, `HEMS.today.acExportTodayKWh`, hemsExportWhAdd);
            await this.addWhAndUpdateKWh(`HEMS.today.pvToBatteryTodayWh`, `HEMS.today.pvToBatteryTodayKWh`, hemsPvToBatteryWhAdd);
            await this.addWhAndUpdateKWh(`HEMS.today.pvTodayWh`, `HEMS.today.pvTodayKWh`, hemsPvWhAdd);
        }
    }

    async updateHems() {
        const hemsDevices = this.devices.filter(d => d.isInHems);
        if (!hemsDevices.length) return;

        await this.ensureHemsObjects();
        await this.ensureHemsTodayObjects();

        const allDev = [];
        for (const dev of hemsDevices) {
            const base = dev.id;
            const online = !!(await this.getStateAsync(`${base}.online`))?.val;
            const stale = !!(await this.getStateAsync(`${base}.stale`))?.val;
            const outputPackPower = this.safeNum((await this.getStateAsync(`${base}.outputPackPower`))?.val, 0);
            const packInputPower = this.safeNum((await this.getStateAsync(`${base}.packInputPower`))?.val, 0);

            allDev.push({
                key: dev.id,
                type: dev.type || "ac",
                capKWh: Number(dev.capKWh) > 0 ? Number(dev.capKWh) : ((dev.type || "ac") === "pro" ? 7.4 : 2.4),
                online,
                stale,
                lastUpdate: this.safeNum((await this.getStateAsync(`${base}.lastUpdate`))?.val, 0),
                soc: this.safeNum((await this.getStateAsync(`${base}.soc`))?.val, 0),
                acChargingW: this.safeNum((await this.getStateAsync(`${base}.acChargingW`))?.val, 0),
                acDischargingW: this.safeNum((await this.getStateAsync(`${base}.acDischargingW`))?.val, 0),
                acDirectionW: this.safeNum((await this.getStateAsync(`${base}.acDirectionW`))?.val, 0),
                acPowerW: this.safeNum((await this.getStateAsync(`${base}.acPowerW`))?.val, 0),
                solarInputPower: this.safeNum((await this.getStateAsync(`${base}.solarInputPower`))?.val, 0),
                outputPackPower,
                packInputPower,
                minSocPct: this.safeNum((await this.getStateAsync(`${base}.minSocPct`))?.val, 0),
                socSetPct: this.safeNum((await this.getStateAsync(`${base}.socSetPct`))?.val, 0),
            });
        }

        const devicesConfigured = allDev.length;
        const devicesActive = allDev.filter(d => d.online && !d.stale).length;
        const onlineAll = allDev.every(d => d.online);
        const onlineAny = allDev.some(d => d.online);
        const staleAll = allDev.every(d => d.stale);
        const staleAny = allDev.some(d => d.stale);
        const times = allDev.map(d => d.lastUpdate).filter(v => v > 0);
        const lastUpdateMin = times.length ? Math.min(...times) : 0;
        const lastUpdateMax = times.length ? Math.max(...times) : 0;

        const active = allDev.filter(d => d.online && !d.stale);

        const socAvg = active.length ? Math.round((active.reduce((a, d) => a + d.soc, 0) / active.length) * 10) / 10 : 0;
        let capSum = 0;
        let socCapSum = 0;
        let energyRemainingKWh = 0;
        let energyUsableKWh = 0;
        for (const d of active) {
            capSum += d.capKWh;
            socCapSum += d.soc * d.capKWh;
            energyRemainingKWh += Math.max(0, d.soc) / 100 * d.capKWh;
        }
        const socWeighted = capSum > 0 ? Math.round((socCapSum / capSum) * 10) / 10 : socAvg;
        const acChargingW = active.reduce((a, d) => a + Math.max(0, d.acChargingW), 0);
        const acDischargingW = active.reduce((a, d) => a + Math.max(0, d.acDischargingW), 0);
        const acDirectionW = active.reduce((a, d) => a + d.acDirectionW, 0);
        const acPowerW = active.reduce((a, d) => a + d.acPowerW, 0);
        const solarInputPower = active.reduce((a, d) => a + Math.max(0, d.solarInputPower), 0);

        const batteryChargeTotalW = active.reduce((sum, d) => {
            if (d.type === "pro") return sum + Math.max(0, d.outputPackPower);
            return sum + Math.max(0, d.acChargingW);
        }, 0);

        const batteryDischargeTotalW = active.reduce((sum, d) => {
            if (d.type === "pro") return sum + Math.max(0, d.packInputPower);
            return sum + Math.max(0, d.acDischargingW);
        }, 0);

        const rawBatteryNetPowerW = batteryDischargeTotalW - batteryChargeTotalW;
        const batteryNetPowerW = Math.abs(rawBatteryNetPowerW) <= HEMS_DEADBAND_W ? 0 : rawBatteryNetPowerW;

        let batteryNetModeText = "idle";
        if (batteryNetPowerW > 0) batteryNetModeText = "entlädt";
        else if (batteryNetPowerW < 0) batteryNetModeText = "lädt";

        const minSocVals = active.map(d => d.minSocPct).filter(v => v > 0);
        const socSetVals = active.map(d => d.socSetPct).filter(v => v > 0);
        const minSocPct = minSocVals.length ? Math.max(...minSocVals) : 0;
        const socSetPct = socSetVals.length ? Math.min(...socSetVals) : 0;
        for (const d of active) {
            energyUsableKWh += Math.max(0, d.soc - minSocPct) / 100 * d.capKWh;
        }
        energyRemainingKWh = Math.round(energyRemainingKWh * 100) / 100;
        energyUsableKWh = Math.round(energyUsableKWh * 100) / 100;

        const hemsStates = {
            devicesConfigured,
            devicesActive,
            onlineAll,
            onlineAny,
            staleAll,
            staleAny,
            lastUpdateMin,
            lastUpdateMax,
            socAvg,
            socWeighted,
            energyRemainingKWh,
            energyUsableKWh,
            acChargingW,
            acDischargingW,
            acDirectionW,
            acPowerW,
            solarInputPower,
            batteryChargeTotalW,
            batteryDischargeTotalW,
            batteryNetPowerW,
            batteryNetModeText,
            minSocPct,
            socSetPct,
        };

        for (const [key, val] of Object.entries(hemsStates)) {
            await this.setStateChangedAsync(`HEMS.${key}`, { val, ack: true });
        }
    }

    async ensureChannel(id) {
        const key = `channel:${id}`;
        if (this.objectCache.has(key)) return;
        await this.extendObjectAsync(id, {
            type: "channel",
            common: { name: id.split(".").slice(-1)[0] },
            native: {}
        });
        this.objectCache.add(key);
    }

    async ensureState(id, type, role, def, unit = "") {
        const key = `state:${id}`;
        if (this.objectCache.has(key)) return;
        await this.extendObjectAsync(id, {
            type: "state",
            common: {
                name: id.split(".").slice(-1)[0],
                type,
                role,
                read: true,
                write: false,
                def,
                unit,
            },
            native: {}
        });
        this.objectCache.add(key);
    }

    async ensureDeviceObjects(dev) {
        await this.ensureChannel(dev.id);

        const defs = [
            ["soc", "number", "value.battery", 0, "%"],
            ["acPowerW", "number", "value.power", 0, "W"],
            ["acDirectionW", "number", "value.power", 0, "W"],
            ["acChargingW", "number", "value.power", 0, "W"],
            ["acDischargingW", "number", "value.power", 0, "W"],
            ["solarInputPower", "number", "value.power", 0, "W"],
            ["solarPower1", "number", "value.power", 0, "W"],
            ["solarPower2", "number", "value.power", 0, "W"],
            ["solarPower3", "number", "value.power", 0, "W"],
            ["solarPower4", "number", "value.power", 0, "W"],
            ["outputPackPower", "number", "value.power", 0, "W"],
            ["packInputPower", "number", "value.power", 0, "W"],
            ["minSocPct", "number", "value.battery", 0, "%"],
            ["socSetPct", "number", "value.battery", 0, "%"],
            ["online", "boolean", "indicator.reachable", false],
            ["lastUpdate", "number", "value.time", 0, "ms"],
            ["ageSec", "number", "value.interval", 0, "s"],
            ["stale", "boolean", "indicator.maintenance", false],
            ["rssi", "number", "value", 0, "dBm"],
            ["rawJson", "string", "json", ""],
        ];
        for (const [name, type, role, def, unit] of defs) {
            await this.ensureState(`${dev.id}.${name}`, type, role, def, unit || "");
        }
    }

    async ensureDeviceTodayObjects(dev) {
        await this.ensureChannel(`${dev.id}.today`);
        const defs = [
            ["acImportTodayWh", "number", "value.energy", 0, "Wh"],
            ["acImportTodayKWh", "number", "value.energy", 0, "kWh"],
            ["acExportTodayWh", "number", "value.energy", 0, "Wh"],
            ["acExportTodayKWh", "number", "value.energy", 0, "kWh"],
            ["pvTodayWh", "number", "value.energy", 0, "Wh"],
            ["pvTodayKWh", "number", "value.energy", 0, "kWh"],
            ["lastResetDate", "string", "text", ""],
        ];

        for (const [name, type, role, def, unit] of defs) {
            await this.ensureState(`${dev.id}.today.${name}`, type, role, def, unit || "");
        }
    }

    async ensureDeviceProTodayObjects(deviceId) {
        await this.ensureChannel(`${deviceId}.today`);
        await this.ensureState(`${deviceId}.today.pvToBatteryTodayWh`, "number", "value.energy", 0, "Wh");
        await this.ensureState(`${deviceId}.today.pvToBatteryTodayKWh`, "number", "value.energy", 0, "kWh");
    }

    async ensureHemsObjects() {
        await this.ensureChannel("HEMS");
        const defs = [
            ["devicesConfigured", "number", "value", 0],
            ["devicesActive", "number", "value", 0],
            ["onlineAll", "boolean", "indicator.reachable", false],
            ["onlineAny", "boolean", "indicator.reachable", false],
            ["staleAll", "boolean", "indicator.maintenance", false],
            ["staleAny", "boolean", "indicator.maintenance", false],
            ["lastUpdateMin", "number", "value.time", 0, "ms"],
            ["lastUpdateMax", "number", "value.time", 0, "ms"],
            ["socAvg", "number", "value.battery", 0, "%"],
            ["socWeighted", "number", "value.battery", 0, "%"],
            ["energyRemainingKWh", "number", "value.energy", 0, "kWh"],
            ["energyUsableKWh", "number", "value.energy", 0, "kWh"],
            ["acChargingW", "number", "value.power", 0, "W"],
            ["acDischargingW", "number", "value.power", 0, "W"],
            ["acDirectionW", "number", "value.power", 0, "W"],
            ["acPowerW", "number", "value.power", 0, "W"],
            ["solarInputPower", "number", "value.power", 0, "W"],
            ["batteryChargeTotalW", "number", "value.power", 0, "W"],
            ["batteryDischargeTotalW", "number", "value.power", 0, "W"],
            ["batteryNetPowerW", "number", "value.power", 0, "W"],
            ["batteryNetModeText", "string", "text", "idle"],
            ["minSocPct", "number", "value.battery", 0, "%"],
            ["socSetPct", "number", "value.battery", 0, "%"],
        ];
        for (const [name, type, role, def, unit] of defs) {
            await this.ensureState(`HEMS.${name}`, type, role, def, unit || "");
        }
    }

    async ensureHemsTodayObjects() {
        await this.ensureChannel("HEMS.today");
        const defs = [
            ["acImportTodayWh", "number", "value.energy", 0, "Wh"],
            ["acImportTodayKWh", "number", "value.energy", 0, "kWh"],
            ["acExportTodayWh", "number", "value.energy", 0, "Wh"],
            ["acExportTodayKWh", "number", "value.energy", 0, "kWh"],
            ["pvToBatteryTodayWh", "number", "value.energy", 0, "Wh"],
            ["pvToBatteryTodayKWh", "number", "value.energy", 0, "kWh"],
            ["pvTodayWh", "number", "value.energy", 0, "Wh"],
            ["pvTodayKWh", "number", "value.energy", 0, "kWh"],
            ["lastResetDate", "string", "text", ""],
        ];
        for (const [name, type, role, def, unit] of defs) {
            await this.ensureState(`HEMS.today.${name}`, type, role, def, unit || "");
        }
    }
}


if (require.main !== module) {
    module.exports = options => new ZendureIpAdapter(options);
} else {
    (() => new ZendureIpAdapter())();
}
