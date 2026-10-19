'use strict';

/*
 * A simulated Sonos household: one HTTP server per speaker, sharing the group state.
 * Behaves like the real thing where it matters: only a group coordinator accepts a new
 * URI or Play (UPnP error 800 otherwise), Stop without anything loaded fails (701).
 */

const http = require('node:http');
const { escapeXml } = require('../lib/sonos');

async function fakeHousehold(names, { favorites = [] } = {}) {
    const speakers = [];
    const byUuid = uuid => speakers.find(s => s.uuid === uuid);
    const members = coord => speakers.filter(s => s.coordinator === coord);

    const fault = (res, code) => {
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
    };
    const reply = (res, action, inner = '') => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
    };

    function topology() {
        const groups = speakers
            .filter(s => s.coordinator === s.uuid)
            .map(
                c =>
                    `<ZoneGroup Coordinator="${c.uuid}" ID="${c.uuid}:1">` +
                    members(c.uuid)
                        .map(m => `<ZoneGroupMember UUID="${m.uuid}" Location="http://127.0.0.1:${m.port}/xml/device_description.xml" ZoneName="${escapeXml(m.name)}"/>`)
                        .join('') +
                    // a bonded sub: must be ignored
                    (c.name === names[0] ? `<ZoneGroupMember UUID="RINCON_SUB" Location="http://127.0.0.1:1/x.xml" ZoneName="${escapeXml(c.name)}" Invisible="1"/>` : '') +
                    '</ZoneGroup>',
            )
            .join('');
        return `<ZoneGroupState><ZoneGroups>${groups}</ZoneGroups></ZoneGroupState>`;
    }

    function handle(sp, req, res, body) {
        if (req.method === 'GET' && req.url === '/xml/device_description.xml') {
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(`<root><device><roomName>${escapeXml(sp.name)}</roomName><modelName>Sonos One</modelName><UDN>uuid:${sp.uuid}</UDN></device></root>`);
            return;
        }
        const action = /#(\w+)"?$/.exec(req.headers.soapaction || '')[1];
        const arg = n => {
            const m = new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(body);
            return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '';
        };
        sp.calls.push(action);
        const coord = byUuid(sp.coordinator);
        switch (action) {
            case 'GetZoneGroupState':
                return reply(res, action, `<ZoneGroupState>${escapeXml(topology())}</ZoneGroupState>`);
            case 'SetAVTransportURI': {
                const uri = arg('CurrentURI');
                if (uri.startsWith('x-rincon:')) {
                    sp.coordinator = uri.slice(9);
                    sp.uri = '';
                    return reply(res, action);
                }
                if (sp.coordinator !== sp.uuid) {
                    return fault(res, 800);
                }
                Object.assign(sp, { uri, meta: arg('CurrentURIMetaData'), state: 'STOPPED' });
                return reply(res, action);
            }
            case 'Play':
                if (sp.coordinator !== sp.uuid) {
                    return fault(res, 800);
                }
                if (!sp.uri) {
                    return fault(res, 701);
                }
                sp.state = 'PLAYING';
                return reply(res, action);
            case 'Stop':
                if (!sp.uri) {
                    return fault(res, 701);
                }
                sp.state = 'STOPPED';
                return reply(res, action);
            case 'BecomeCoordinatorOfStandaloneGroup': {
                if (sp.coordinator === sp.uuid) {
                    const rest = members(sp.uuid).filter(m => m !== sp);
                    if (rest.length) {
                        // the group goes on with the next member as coordinator
                        const next = rest[0];
                        Object.assign(next, { uri: sp.uri, meta: sp.meta, state: sp.state });
                        for (const m of rest) {
                            m.coordinator = next.uuid;
                        }
                    }
                }
                Object.assign(sp, { coordinator: sp.uuid, uri: '', meta: '', state: 'STOPPED' });
                return reply(res, action);
            }
            case 'GetTransportInfo':
                return reply(res, action, `<CurrentTransportState>${coord.state}</CurrentTransportState>`);
            case 'GetMediaInfo':
                return reply(res, action, `<CurrentURI>${escapeXml(coord.uri)}</CurrentURI><CurrentURIMetaData>${escapeXml(coord.meta)}</CurrentURIMetaData>`);
            case 'GetPositionInfo': {
                const meta = coord.state === 'PLAYING' ? '<DIDL-Lite><item><r:streamContent>ABBA - Waterloo</r:streamContent></item></DIDL-Lite>' : '';
                return reply(res, action, `<TrackMetaData>${escapeXml(meta)}</TrackMetaData>`);
            }
            case 'GetVolume':
                return reply(res, action, `<CurrentVolume>${sp.volume}</CurrentVolume>`);
            case 'SetVolume':
                sp.volume = Number(arg('DesiredVolume'));
                return reply(res, action);
            case 'Browse': {
                const didl =
                    '<DIDL-Lite>' +
                    favorites
                        .map(f => `<item id="FV:2/1"><dc:title>${escapeXml(f.title)}</dc:title><res>${escapeXml(f.uri)}</res><r:resMD>${escapeXml(f.meta)}</r:resMD></item>`)
                        .join('') +
                    '<container id="FV:2/9"><dc:title>Playlist</dc:title></container></DIDL-Lite>';
                return reply(res, action, `<Result>${escapeXml(didl)}</Result><NumberReturned>${favorites.length}</NumberReturned>`);
            }
            default:
                return fault(res, 401);
        }
    }

    for (const [i, name] of names.entries()) {
        const sp = { name, uuid: `RINCON_${i + 1}00001400`, volume: 20, state: 'STOPPED', uri: '', meta: '', calls: [] };
        sp.coordinator = sp.uuid;
        sp.server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => handle(sp, req, res, Buffer.concat(chunks).toString()));
        });
        await new Promise(r => sp.server.listen(0, '127.0.0.1', r));
        sp.port = sp.server.address().port;
        sp.host = `127.0.0.1:${sp.port}`;
        speakers.push(sp);
    }
    return {
        speakers,
        get: name => speakers.find(s => s.name === name),
        close: () => Promise.all(speakers.map(s => new Promise(r => { s.server.closeAllConnections(); s.server.close(r); }))),
    };
}

module.exports = { fakeHousehold };
