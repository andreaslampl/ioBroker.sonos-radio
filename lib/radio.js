'use strict';

/*
 * Radio controller: knows the Sonos rooms and the station list, plays a station in one or
 * more rooms (grouped), stops, sets volumes and polls what is playing.
 *
 * Station sources, in this order: a Sonos favorite with the station's name (exactly what
 * the Sonos app plays, so always works), otherwise the stream URL from the settings.
 * Errors thrown by commands are shown on the touch page, so they are in German.
 */

const { EventEmitter } = require('node:events');
const { SonosPlayer, radioUri, radioMetadata } = require('./sonos');
const { discover } = require('./discovery');
const { slug } = require('./util');

/** Compare names loosely: "Hitradio Ö3" ~ "hitradio oe3", "Radio 88,6" ~ "Radio 88.6". */
function norm(s) {
    return slug(s).replace(/_/g, '');
}

class Radio extends EventEmitter {
    /**
     * @param {object} options
     * @param {Array<{name: string, url?: string, favorite?: string, logo?: string, color?: string}>} options.stations
     * @param {string[]} [options.hosts] IPs of Sonos players (any one is enough); empty = search the network
     * @param {object} options.log
     * @param {number} [options.pollInterval] ms
     */
    constructor({ stations, hosts = [], log, pollInterval = 4000, discoverFn = discover, timeout = 5000 }) {
        super();
        const used = new Set();
        this.stations = stations.map((s, i) => {
            let id = slug(s.name) || `station${i + 1}`;
            while (used.has(id)) {
                id = `${id}_${i + 1}`;
            }
            used.add(id);
            return { ...s, id };
        });
        this.hosts = hosts.map(h => String(h).trim()).filter(Boolean);
        this.log = log;
        this.pollInterval = pollInterval;
        this.discoverFn = discoverFn;
        this.timeout = timeout;
        this.rooms = new Map(); // id -> room
        this.favorites = [];
        this.favoritesAt = 0;
        this.lastStation = new Map(); // room id -> station id
        this.queue = Promise.resolve();
        this.timer = null;
        this.lastDiscovery = 0;
        this.lastStatus = '';
    }

    async start() {
        await this.refresh().catch(err => this.log.warn(err.message));
        const loop = async () => {
            await this.refresh().catch(err => this.log.debug(err.message));
            if (this.timer !== null) {
                this.timer = setTimeout(loop, this.pollInterval);
            }
        };
        this.timer = setTimeout(loop, this.pollInterval);
    }

    /** End polling. */
    close() {
        clearTimeout(this.timer);
        this.timer = null;
    }

    /** Run Sonos commands one after another, so taps in quick succession do not interleave. */
    _serial(fn) {
        const run = this.queue.then(fn);
        this.queue = run.catch(() => {});
        return run;
    }

    _player(host) {
        return new SonosPlayer(host, { timeout: this.timeout });
    }

    /** Room topology from any reachable player; searches the network if none is known or reachable. */
    async _topology() {
        const candidates = [...new Set([...[...this.rooms.values()].filter(r => r.online).map(r => r.host), ...this.hosts])];
        for (const host of candidates) {
            try {
                return await this._player(host).topology();
            } catch {
                // try the next one
            }
        }
        if (Date.now() - this.lastDiscovery > 60000 || !this.lastDiscovery) {
            this.lastDiscovery = Date.now();
            const found = await this.discoverFn();
            for (const host of found) {
                try {
                    return await this._player(host).topology();
                } catch {
                    // try the next one
                }
            }
        }
        throw new Error(
            this.hosts.length
                ? `No Sonos player reachable at ${this.hosts.join(', ')}`
                : 'No Sonos player found in the network (enter the IP of one player in the settings)',
        );
    }

    async _updateTopology() {
        let list;
        try {
            list = await this._topology();
        } catch (err) {
            for (const r of this.rooms.values()) {
                r.online = false;
            }
            throw err;
        }
        const seen = new Set();
        for (const t of list) {
            const id = slug(t.name) || slug(t.uuid);
            seen.add(id);
            const room = this.rooms.get(id) || { id, state: 'STOPPED', station: '', title: '', volume: 0 };
            if (!this.rooms.has(id)) {
                this.log.info(`Sonos room "${t.name}" found at ${t.host}`);
            }
            Object.assign(room, { name: t.name, uuid: t.uuid, host: t.host, coordinator: t.coordinator, online: true });
            room.player = this._player(t.host);
            this.rooms.set(id, room);
        }
        for (const [id, r] of this.rooms) {
            if (!seen.has(id)) {
                r.online = false;
            }
        }
    }

    _byUuid(uuid) {
        return [...this.rooms.values()].find(r => r.uuid === uuid);
    }

    /** Topology, what is playing and volumes; emits 'status' when something changed. */
    async refresh() {
        try {
            await this._updateTopology();
            const coordinators = new Map();
            for (const r of this.rooms.values()) {
                if (r.online && r.coordinator === r.uuid) {
                    coordinators.set(r.uuid, r);
                }
            }
            for (const c of coordinators.values()) {
                try {
                    c.state = await c.player.transportState();
                    const now = await c.player.nowPlaying();
                    c.station = this._matchStation(now);
                    c.stationName = c.station ? this.stations.find(s => s.id === c.station).name : now.station;
                    c.title = now.title;
                } catch (err) {
                    this.log.debug(err.message);
                }
            }
            for (const r of this.rooms.values()) {
                if (!r.online) {
                    continue;
                }
                const c = coordinators.get(r.coordinator) || r;
                if (c !== r) {
                    Object.assign(r, { state: c.state, station: c.station, stationName: c.stationName, title: c.title });
                }
                try {
                    r.volume = await r.player.getVolume();
                } catch (err) {
                    this.log.debug(err.message);
                }
            }
        } finally {
            this._emitStatus();
        }
    }

    _matchStation(now) {
        const fav = uri => this.favorites.find(f => f.uri === uri);
        for (const s of this.stations) {
            if (s.url && radioUri(s.url) === now.uri) {
                return s.id;
            }
            const f = fav(now.uri);
            if (f && this._favoriteFor(s) === f) {
                return s.id;
            }
        }
        const t = norm(now.station);
        const byName = t && this.stations.find(s => norm(s.name) === t || norm(s.favorite || '') === t);
        return byName ? byName.id : '';
    }

    status() {
        const rooms = [...this.rooms.values()]
            .sort((a, b) => a.name.localeCompare(b.name, 'de'))
            .map(r => {
                const group = [...this.rooms.values()].filter(o => o.online && o.coordinator === r.coordinator && o !== r).map(o => o.name);
                return {
                    id: r.id,
                    name: r.name,
                    online: r.online,
                    playing: r.online && (r.state === 'PLAYING' || r.state === 'TRANSITIONING'),
                    station: r.station || '',
                    stationName: r.stationName || '',
                    title: r.title || '',
                    volume: r.volume || 0,
                    group,
                };
            });
        return {
            rooms,
            stations: this.stations.map(({ id, name, logo, color }) => ({ id, name, logo: logo || '', color: color || '' })),
        };
    }

    _emitStatus() {
        const st = this.status();
        const json = JSON.stringify(st);
        if (json !== this.lastStatus) {
            this.lastStatus = json;
            this.emit('status', st);
        }
    }

    _room(id) {
        const r = this.rooms.get(id);
        if (!r) {
            throw new Error(`Unbekannter Raum "${id}"`);
        }
        if (!r.online) {
            throw new Error(`${r.name} ist nicht erreichbar`);
        }
        return r;
    }

    async _source(station) {
        if (Date.now() - this.favoritesAt > 10 * 60000) {
            const any = [...this.rooms.values()].find(r => r.online);
            if (any) {
                try {
                    this.favorites = await any.player.favorites();
                    this.favoritesAt = Date.now();
                } catch (err) {
                    this.log.debug(`Sonos favorites: ${err.message}`);
                }
            }
        }
        const fav = this._favoriteFor(station);
        if (fav) {
            return { uri: fav.uri, metadata: fav.metadata, from: `Sonos favorite "${fav.title}"` };
        }
        if (station.favorite) {
            this.log.warn(`Sonos favorite "${station.favorite}" not found, using the stream URL`);
        }
        if (!station.url) {
            throw new Error(`Sender "${station.name}": kein Sonos-Favorit mit diesem Namen und keine Stream-Adresse`);
        }
        return { uri: radioUri(station.url), metadata: radioMetadata(station.name), from: station.url };
    }

    /** Sonos favorite for a station: same name, otherwise one whose name contains it ("Ö3" -> "Hitradio Ö3"). */
    _favoriteFor(station) {
        const wanted = norm(station.favorite || station.name);
        if (!wanted) {
            return null;
        }
        return (
            this.favorites.find(f => norm(f.title) === wanted) ||
            (wanted.length >= 3 ? this.favorites.find(f => norm(f.title).includes(wanted)) : null) ||
            null
        );
    }

    /**
     * Play a station in these rooms (first room leads, the others join it).
     *
     * @param {string[]} roomIds
     * @param {string} stationId station id or name
     */
    play(roomIds, stationId) {
        return this._serial(async () => {
            const station = this.stations.find(s => s.id === stationId || norm(s.name) === norm(stationId));
            if (!station) {
                throw new Error(`Unbekannter Sender "${stationId}"`);
            }
            if (!roomIds.length) {
                throw new Error('Kein Raum ausgewählt');
            }
            await this._updateTopology();
            const targets = roomIds.map(id => this._room(id));
            const lead = targets[0];
            if (lead.coordinator !== lead.uuid) {
                await lead.player.leaveGroup();
            } else {
                // Rooms that were grouped with the lead but are not selected now leave the group.
                for (const r of this.rooms.values()) {
                    if (r !== lead && r.online && r.coordinator === lead.uuid && !targets.includes(r)) {
                        await r.player.leaveGroup().catch(err => this.log.debug(err.message));
                    }
                }
            }
            const src = await this._source(station);
            this.log.info(`Playing ${station.name} in ${targets.map(r => r.name).join(', ')} (${src.from})`);
            await lead.player.setUri(src.uri, src.metadata);
            await lead.player.play();
            for (const r of targets.slice(1)) {
                await r.player.joinGroup(lead.uuid);
            }
            for (const r of targets) {
                this.lastStation.set(r.id, station.id);
            }
            await this.refresh().catch(() => {});
        });
    }

    /** Play the last station of this room again (or the first station). */
    resume(roomId) {
        return this.play([roomId], this.lastStation.get(roomId) || (this.rooms.get(roomId) || {}).station || this.stations[0].id);
    }

    stop(roomIds) {
        return this._serial(async () => {
            await this._updateTopology();
            for (const id of roomIds) {
                const r = this._room(id);
                if (r.coordinator !== r.uuid) {
                    // Member of a group: just leave it, the others keep playing.
                    await r.player.leaveGroup();
                    continue;
                }
                const others = [...this.rooms.values()].filter(o => o !== r && o.online && o.coordinator === r.uuid);
                if (others.some(o => !roomIds.includes(o.id))) {
                    // Lead of a group whose other rooms keep playing: hand the group over, then stop.
                    await r.player.leaveGroup();
                }
                await r.player.stop().catch(err => this.log.debug(err.message)); // nothing loaded: fine
            }
            await this.refresh().catch(() => {});
        });
    }

    setVolume(roomId, volume) {
        return this._serial(async () => {
            const r = this._room(roomId);
            await r.player.setVolume(volume);
            r.volume = Math.round(Math.min(100, Math.max(0, Number(volume) || 0)));
            this._emitStatus();
        });
    }
}

module.exports = { Radio, norm };
