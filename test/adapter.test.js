'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { fakeHousehold } = require('./fake-sonos');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.log = { debug() {}, info() {}, warn() {}, error: m => this.errors.push(m) };
        this.errors = [];
    }
    async setState(id, val, ack) {
        this.states[id] = { val, ack };
    }
    async extendObject(id, obj) {
        this.objects[id] = obj;
    }
    subscribeStates() {}
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter };
    }
    return origLoad.call(this, request, ...rest);
};

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

test('adapter: rooms as objects, play, volume and stop from ioBroker states', async t => {
    const house = await fakeHousehold(['Küche', 'Terrasse']);
    t.after(() => house.close());
    const adapter = require('../main.js')({
        config: {
            port: 40000 + Math.floor(Math.random() * 10000),
            publicHost: '127.0.0.1',
            hosts: house.get('Terrasse').host,
            stations: [
                { enabled: true, name: 'Kronehit', url: 'http://onair.krone.at/kronehit.mp3' },
                { enabled: false, name: 'Aus', url: 'http://x/y' },
                { enabled: true, name: 'Antenne Kärnten', url: 'http://live.antenne.at/ak' },
            ],
        },
    });
    adapter.emit('ready');
    const s = adapter.states;
    await until(() => s['info.connection'] && s['info.connection'].val === true && s['rooms.kueche.volume']);
    t.after(() => new Promise(resolve => adapter.emit('unload', resolve)));
    assert.match(s['info.pageUrl'].val, /^http:\/\/127\.0\.0\.1:\d+\/radio$/);
    assert.deepEqual(Object.keys(adapter.objects['rooms.kueche.station'].common.states), ['Kronehit', 'Antenne Kärnten']);
    assert.equal(adapter.objects['rooms.kueche.volume'].common.write, true);
    assert.equal(s['rooms.kueche.playing'].val, false);

    await adapter.onStateChange(`${adapter.namespace}.rooms.kueche.station`, { val: 'Antenne Kärnten', ack: false });
    assert.equal(house.get('Küche').uri, 'x-rincon-mp3radio://live.antenne.at/ak');
    assert.deepEqual(s['rooms.kueche.station'], { val: 'Antenne Kärnten', ack: true });
    assert.equal(s['rooms.kueche.playing'].val, true);
    assert.equal(s['rooms.kueche.title'].val, 'ABBA - Waterloo');

    await adapter.onStateChange(`${adapter.namespace}.rooms.kueche.volume`, { val: 33, ack: false });
    assert.equal(house.get('Küche').volume, 33);
    assert.deepEqual(s['rooms.kueche.volume'], { val: 33, ack: true });

    await adapter.onStateChange(`${adapter.namespace}.rooms.kueche.playing`, { val: false, ack: false });
    assert.equal(house.get('Küche').state, 'STOPPED');
    assert.deepEqual(s['rooms.kueche.playing'], { val: false, ack: true });
    await adapter.onStateChange(`${adapter.namespace}.rooms.kueche.playing`, { val: true, ack: false });
    assert.equal(house.get('Küche').state, 'PLAYING');
    assert.equal(house.get('Küche').uri, 'x-rincon-mp3radio://live.antenne.at/ak'); // last station again

    // unknown station: no crash, real value written back
    await adapter.onStateChange(`${adapter.namespace}.rooms.kueche.station`, { val: 'Bayern 3', ack: false });
    assert.deepEqual(s['rooms.kueche.station'], { val: 'Antenne Kärnten', ack: true });
});
