'use strict';

const os = require('node:os');
const utils = require('@iobroker/adapter-core');
const { Radio } = require('./lib/radio');
const { RadioServer } = require('./lib/server');

function localAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
}

class SonosRadio extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'sonos-radio' });
        this.radio = null;
        this.server = null;
        this.known = new Set(); // rooms with objects
        this.last = new Map(); // state id -> last written value
        this.discoverFn = undefined; // injectable for tests
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const stations = (Array.isArray(this.config.stations) ? this.config.stations : [])
            .filter(s => s.enabled !== false && String(s.name || '').trim())
            .map(s => ({
                name: String(s.name).trim(),
                url: String(s.url || '').trim(),
                favorite: String(s.favorite || '').trim(),
                logo: String(s.logo || '').trim(),
                color: String(s.color || '').trim(),
            }));
        if (!stations.length) {
            this.log.error('No stations configured');
            return;
        }
        const hosts = String(this.config.hosts || '')
            .split(/[,;\s]+/)
            .filter(Boolean);
        this.radio = new Radio({
            stations,
            hosts,
            log: this.log,
            pollInterval: (Number(this.config.pollInterval) || 4) * 1000,
            ...(this.discoverFn ? { discoverFn: this.discoverFn } : {}),
        });
        this.radio.on('status', st => this.onStatus(st).catch(err => this.log.warn(err.message)));

        const port = Number(this.config.port) || 8096;
        this.server = new RadioServer({ radio: this.radio, log: this.log });
        try {
            await this.server.listen(port);
        } catch (err) {
            this.log.error(`Cannot open port ${port}: ${err.message}. Choose another port in the settings.`);
            return;
        }
        const host = (this.config.publicHost || '').trim() || localAddress();
        await this.setState('info.pageUrl', `http://${host}:${port}/radio`, true);
        this.log.info(`Radio page at http://${host}:${port}/radio`);
        this.subscribeStates('rooms.*');
        await this.radio.start();
    }

    async _set(id, val) {
        if (this.last.get(id) !== val) {
            this.last.set(id, val);
            await this.setState(id, val, true);
        }
    }

    async onStatus(st) {
        await this._set('info.connection', st.rooms.some(r => r.online));
        for (const r of st.rooms) {
            if (!this.known.has(r.id)) {
                this.known.add(r.id);
                await this.createRoomObjects(r.id, r.name, st.stations);
            }
            const p = `rooms.${r.id}`;
            await this._set(`${p}.online`, r.online);
            await this._set(`${p}.playing`, r.playing);
            await this._set(`${p}.station`, r.playing ? r.stationName : '');
            await this._set(`${p}.title`, r.playing ? r.title : '');
            await this._set(`${p}.volume`, r.volume);
            await this._set(`${p}.group`, r.group.join(', '));
        }
    }

    async createRoomObjects(id, name, stations) {
        await this.extendObject(`rooms.${id}`, { type: 'channel', common: { name }, native: {} });
        const states = {
            station: {
                name: { en: 'Station (write a name to play it)', de: 'Sender (Name schreiben = abspielen)' },
                type: 'string',
                role: 'media.station',
                write: true,
                states: Object.fromEntries(stations.map(s => [s.name, s.name])),
            },
            playing: { name: { en: 'Playing (false = stop)', de: 'Spielt (false = Stopp)' }, type: 'boolean', role: 'switch', write: true },
            volume: { name: { en: 'Volume', de: 'Lautstärke' }, type: 'number', role: 'level.volume', min: 0, max: 100, unit: '%', write: true },
            title: { name: { en: 'Now playing', de: 'Aktueller Titel' }, type: 'string', role: 'media.title', write: false },
            group: { name: { en: 'Playing together with', de: 'Spielt zusammen mit' }, type: 'string', role: 'text', write: false },
            online: { name: { en: 'Reachable', de: 'Erreichbar' }, type: 'boolean', role: 'indicator.reachable', write: false },
        };
        for (const [key, common] of Object.entries(states)) {
            await this.extendObject(`rooms.${id}.${key}`, { type: 'state', common: { read: true, ...common }, native: {} });
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack || !this.radio) {
            return;
        }
        const m = /\.rooms\.([^.]+)\.(station|playing|volume)$/.exec(id);
        if (!m) {
            return;
        }
        const [, room, key] = m;
        try {
            if (key === 'station') {
                if (state.val) {
                    await this.radio.play([room], String(state.val));
                } else {
                    await this.radio.stop([room]);
                }
            } else if (key === 'playing') {
                await (state.val ? this.radio.resume(room) : this.radio.stop([room]));
            } else {
                await this.radio.setVolume(room, state.val);
            }
        } catch (err) {
            this.log.warn(err.message);
        }
        // Confirm the write with the real value (also when it did not change).
        this.last.delete(`rooms.${room}.${key}`);
        await this.onStatus(this.radio.status()).catch(() => {});
    }

    async onUnload(callback) {
        try {
            if (this.radio) {
                this.radio.close();
            }
            if (this.server) {
                await this.server.close();
            }
            await this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new SonosRadio(options);
} else {
    new SonosRadio();
}
