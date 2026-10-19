'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { fakeHousehold } = require('./fake-sonos');
const { SonosPlayer, radioUri } = require('../lib/sonos');
const { Radio, norm } = require('../lib/radio');
const { RadioServer } = require('../lib/server');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const STATIONS = [
    { name: 'Radio 88.6', url: 'http://radio886.at/streams/radio_88.6/mp3' },
    { name: 'Ö3', url: 'https://orf-live.ors-shoutcast.at/oe3-q2a' },
    { name: 'Kronehit', url: 'http://onair.krone.at/kronehit.mp3' },
];
const FAVORITES = [
    { title: 'Hitradio Ö3', uri: 'x-sonosapi-stream:s8007?sid=254&flags=8224&sn=0', meta: '<DIDL-Lite><item><dc:title>Hitradio Ö3</dc:title></item></DIDL-Lite>' },
];

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

async function setup(t, options = {}) {
    const house = await fakeHousehold(['Fernsehzimmer', 'Küche', 'Terrasse'], { favorites: FAVORITES });
    const radio = new Radio({ stations: STATIONS, hosts: [house.get('Küche').host], log: quiet, pollInterval: 100000, ...options });
    t.after(async () => {
        radio.close();
        await house.close();
    });
    await radio.start();
    return { house, radio };
}

test('helpers: stream URIs and loose names', () => {
    assert.equal(radioUri('http://onair.krone.at/kronehit.mp3'), 'x-rincon-mp3radio://onair.krone.at/kronehit.mp3');
    assert.equal(radioUri('https://a.b/c'), 'https://a.b/c');
    assert.equal(norm('Hitradio Ö3'), 'hitradiooe3');
    assert.equal(norm('Radio 88,6'), norm('radio 88.6'));
});

test('player: topology without bonded subs, favorites without containers', async t => {
    const house = await fakeHousehold(['Küche', 'Terrasse'], { favorites: FAVORITES });
    t.after(() => house.close());
    const p = new SonosPlayer(house.get('Küche').host);
    const rooms = await p.topology();
    assert.deepEqual(rooms.map(r => r.name).sort(), ['Küche', 'Terrasse']);
    assert.equal(rooms.find(r => r.name === 'Terrasse').host, house.get('Terrasse').host);
    const fav = await p.favorites();
    assert.deepEqual(fav, [{ title: 'Hitradio Ö3', uri: FAVORITES[0].uri, metadata: FAVORITES[0].meta }]);
    assert.equal((await p.deviceInfo()).roomName, 'Küche');
});

test('play in two rooms together, status, stop one room', async t => {
    const { house, radio } = await setup(t);
    assert.deepEqual(radio.status().rooms.map(r => r.id), ['fernsehzimmer', 'kueche', 'terrasse']);

    await radio.play(['kueche', 'terrasse'], 'kronehit');
    const kueche = house.get('Küche'), terrasse = house.get('Terrasse');
    assert.equal(kueche.uri, 'x-rincon-mp3radio://onair.krone.at/kronehit.mp3');
    assert.match(kueche.meta, /<dc:title>Kronehit<\/dc:title>/);
    assert.equal(kueche.state, 'PLAYING');
    assert.equal(terrasse.coordinator, kueche.uuid);

    const st = radio.status();
    const room = id => st.rooms.find(r => r.id === id);
    assert.equal(room('kueche').playing, true);
    assert.equal(room('terrasse').playing, true);
    assert.equal(room('terrasse').station, 'kronehit');
    assert.equal(room('terrasse').stationName, 'Kronehit');
    assert.equal(room('kueche').title, 'ABBA - Waterloo');
    assert.deepEqual(room('kueche').group, ['Terrasse']);
    assert.equal(room('fernsehzimmer').playing, false);

    // Terrasse off, Küche keeps playing
    await radio.stop(['terrasse']);
    assert.equal(terrasse.coordinator, terrasse.uuid);
    assert.equal(kueche.state, 'PLAYING');
    assert.equal(radio.status().rooms.find(r => r.id === 'terrasse').playing, false);
});

test('stopping the lead room hands the group over', async t => {
    const { house, radio } = await setup(t);
    await radio.play(['kueche', 'terrasse'], 'kronehit');
    await radio.stop(['kueche']);
    assert.equal(house.get('Küche').state, 'STOPPED');
    assert.equal(house.get('Terrasse').state, 'PLAYING');
    assert.equal(radio.status().rooms.find(r => r.id === 'terrasse').station, 'kronehit');
});

test('a Sonos favorite with the name wins over the URL; a grouped room is taken out first', async t => {
    const { house, radio } = await setup(t);
    await radio.play(['kueche', 'fernsehzimmer'], 'radio_88_6');
    // Fernsehzimmer is now a member of the Küche group; playing Ö3 there alone must work
    await radio.play(['fernsehzimmer'], 'Ö3');
    const tv = house.get('Fernsehzimmer');
    assert.equal(tv.coordinator, tv.uuid);
    assert.equal(tv.uri, FAVORITES[0].uri);
    assert.equal(tv.meta, FAVORITES[0].meta);
    assert.equal(house.get('Küche').uri, 'x-rincon-mp3radio://radio886.at/streams/radio_88.6/mp3');
    const st = radio.status().rooms;
    assert.equal(st.find(r => r.id === 'fernsehzimmer').station, 'oe3');
    assert.equal(st.find(r => r.id === 'kueche').station, 'radio_88_6');
});

test('volume, unknown station, rooms found by network search', async t => {
    const house = await fakeHousehold(['Küche'], {});
    t.after(() => house.close());
    const radio = new Radio({ stations: STATIONS, log: quiet, pollInterval: 100000, discoverFn: async () => [house.get('Küche').host] });
    t.after(() => radio.close());
    await radio.start();
    await radio.setVolume('kueche', 35);
    assert.equal(house.get('Küche').volume, 35);
    await assert.rejects(radio.play(['kueche'], 'Bayern 3'), /Unbekannter Sender/);
    await assert.rejects(radio.play([], 'kronehit'), /Kein Raum/);
    // resume plays the last station of the room again
    await radio.play(['kueche'], 'kronehit');
    await radio.stop(['kueche']);
    await radio.resume('kueche');
    assert.equal(house.get('Küche').state, 'PLAYING');
});

test('web page and WebSocket commands', async t => {
    const { house, radio } = await setup(t);
    const server = new RadioServer({ radio, log: quiet });
    const { port } = await server.listen(0, '127.0.0.1');
    t.after(() => server.close());

    const html = await (await fetch(`http://127.0.0.1:${port}/radio`)).text();
    assert.match(html, /"name":"Kronehit"/);
    new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]); // page script parses

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.on('message', d => msgs.push(JSON.parse(d.toString())));
    t.after(() => ws.close());
    await until(() => msgs.length > 0);
    assert.equal(msgs[0].type, 'status');

    ws.send(JSON.stringify({ type: 'play', station: 'kronehit', rooms: ['terrasse'] }));
    await until(() => msgs.some(m => m.type === 'status' && m.rooms.find(r => r.id === 'terrasse').playing));
    assert.equal(house.get('Terrasse').state, 'PLAYING');

    ws.send(JSON.stringify({ type: 'volume', room: 'terrasse', volume: 44 }));
    await until(() => house.get('Terrasse').volume === 44);

    ws.send(JSON.stringify({ type: 'play', station: 'kronehit', rooms: ['keller'] }));
    await until(() => msgs.some(m => m.type === 'error'));
    assert.match(msgs.find(m => m.type === 'error').message, /Unbekannter Raum/);
});
