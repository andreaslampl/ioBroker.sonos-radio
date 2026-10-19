'use strict';

/*
 * Minimal Sonos control over the local UPnP/SOAP interface (port 1400), no cloud:
 * room topology, play a radio stream or a Sonos favorite, stop, volume, now playing.
 */

const http = require('node:http');

const SERVICES = {
    AVTransport: { path: '/MediaRenderer/AVTransport/Control', urn: 'urn:schemas-upnp-org:service:AVTransport:1' },
    RenderingControl: { path: '/MediaRenderer/RenderingControl/Control', urn: 'urn:schemas-upnp-org:service:RenderingControl:1' },
    ZoneGroupTopology: { path: '/ZoneGroupTopology/Control', urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' },
    ContentDirectory: { path: '/MediaServer/ContentDirectory/Control', urn: 'urn:schemas-upnp-org:service:ContentDirectory:1' },
};

class SonosError extends Error {}

function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeXml(s) {
    return String(s)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&');
}

/** Text of the first element with this local name (any namespace prefix), still XML-escaped. */
function tag(xml, name) {
    const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml || '');
    return m ? m[1] : null;
}

function attr(xml, name) {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml || '');
    return m ? decodeXml(m[1]) : null;
}

/** DIDL-Lite metadata for a radio stream, so the Sonos app shows the station name. */
function radioMetadata(title) {
    return (
        '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
        'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
        `<item id="R:0/0/0" parentID="R:0/0" restricted="true"><dc:title>${escapeXml(title)}</dc:title>` +
        '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>' +
        '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>'
    );
}

/**
 * Sonos URI for a web radio URL. http streams use the radio scheme (shown as a station, no
 * progress bar); https streams are passed as they are, the radio scheme would drop the TLS.
 */
function radioUri(url) {
    const u = String(url).trim();
    if (/^http:\/\//i.test(u)) {
        return `x-rincon-mp3radio://${u.slice(7)}`;
    }
    return u;
}

class SonosPlayer {
    /**
     * @param {string} host IP address, optionally with :port (default 1400)
     */
    constructor(host, { timeout = 5000 } = {}) {
        this.host = /:\d+$/.test(host) ? host : `${host}:1400`;
        this.timeout = timeout;
    }

    _post(path, headers, body) {
        const [hostname, port] = this.host.split(':');
        return new Promise((resolve, reject) => {
            const req = http.request(
                { hostname, port: Number(port), path, method: body === undefined ? 'GET' : 'POST', headers, timeout: this.timeout },
                res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
                },
            );
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', err => reject(new SonosError(`Sonos ${this.host}: ${err.message}`)));
            req.end(body);
        });
    }

    /** Call a UPnP action; returns the response body XML. */
    async soap(service, action, args = {}) {
        const s = SERVICES[service];
        const params = Object.entries(args)
            .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
            .join('');
        const body =
            '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
            `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${s.urn}">${params}</u:${action}></s:Body></s:Envelope>`;
        const res = await this._post(
            s.path,
            { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${s.urn}#${action}"`, 'Content-Length': Buffer.byteLength(body) },
            body,
        );
        if (res.status !== 200) {
            const code = tag(res.body, 'errorCode');
            throw new SonosError(`Sonos ${this.host}: ${action} failed (${code ? `UPnP error ${code}` : `HTTP ${res.status}`})`);
        }
        return res.body;
    }

    async deviceInfo() {
        const res = await this._post('/xml/device_description.xml', {});
        if (res.status !== 200) {
            throw new SonosError(`Sonos ${this.host}: no device description (HTTP ${res.status})`);
        }
        return {
            roomName: decodeXml(tag(res.body, 'roomName') || ''),
            uuid: decodeXml(tag(res.body, 'UDN') || '').replace(/^uuid:/, ''),
            model: decodeXml(tag(res.body, 'modelName') || ''),
        };
    }

    /**
     * All rooms of the household with their groups.
     *
     * @returns {Promise<Array<{uuid: string, name: string, host: string, coordinator: string}>>}
     */
    async topology() {
        const xml = decodeXml(tag(await this.soap('ZoneGroupTopology', 'GetZoneGroupState'), 'ZoneGroupState') || '');
        const rooms = [];
        const groupRe = /<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g;
        let g;
        while ((g = groupRe.exec(xml)) !== null) {
            const coordinator = attr(g[1], 'Coordinator');
            const memberRe = /<ZoneGroupMember\b([^>]*?)\/?>/g;
            let m;
            while ((m = memberRe.exec(g[2])) !== null) {
                // Bonded surround speakers and subs are invisible members of their room.
                if (attr(m[1], 'Invisible') === '1') {
                    continue;
                }
                let host = '';
                try {
                    host = new URL(attr(m[1], 'Location')).host;
                } catch {
                    continue;
                }
                rooms.push({ uuid: attr(m[1], 'UUID'), name: attr(m[1], 'ZoneName'), host, coordinator });
            }
        }
        return rooms;
    }

    async setUri(uri, metadata = '') {
        await this.soap('AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: metadata });
    }

    async play() {
        await this.soap('AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
    }

    async stop() {
        await this.soap('AVTransport', 'Stop', { InstanceID: 0 });
    }

    /** Leave the current group (stops playing there) and become a group of its own. */
    async leaveGroup() {
        await this.soap('AVTransport', 'BecomeCoordinatorOfStandaloneGroup', { InstanceID: 0 });
    }

    /** Join the group of another player and play what it plays. */
    async joinGroup(coordinatorUuid) {
        await this.setUri(`x-rincon:${coordinatorUuid}`);
    }

    async getVolume() {
        return Number(tag(await this.soap('RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }), 'CurrentVolume')) || 0;
    }

    async setVolume(volume) {
        const v = Math.round(Math.min(100, Math.max(0, Number(volume) || 0)));
        await this.soap('RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: v });
    }

    /** PLAYING, PAUSED_PLAYBACK, STOPPED or TRANSITIONING. */
    async transportState() {
        return tag(await this.soap('AVTransport', 'GetTransportInfo', { InstanceID: 0 }), 'CurrentTransportState') || 'STOPPED';
    }

    /** What is loaded: URI, station title and the current song ("Artist - Title") if the stream sends it. */
    async nowPlaying() {
        const media = await this.soap('AVTransport', 'GetMediaInfo', { InstanceID: 0 });
        const uri = decodeXml(tag(media, 'CurrentURI') || '');
        const mediaMeta = decodeXml(tag(media, 'CurrentURIMetaData') || '');
        const pos = await this.soap('AVTransport', 'GetPositionInfo', { InstanceID: 0 });
        const trackMeta = decodeXml(tag(pos, 'TrackMetaData') || '');
        const stream = tag(trackMeta, 'streamContent');
        const title = stream ? decodeXml(stream) : decodeXml(tag(trackMeta, 'title') || '');
        return { uri, station: decodeXml(tag(mediaMeta, 'title') || ''), title: title === 'NOT_IMPLEMENTED' ? '' : title };
    }

    /** "My Sonos" favorites: title, URI and metadata to play them as they are. */
    async favorites() {
        const res = await this.soap('ContentDirectory', 'Browse', {
            ObjectID: 'FV:2',
            BrowseFlag: 'BrowseDirectChildren',
            Filter: 'dc:title,res,r:resMD',
            StartingIndex: 0,
            RequestedCount: 200,
            SortCriteria: '',
        });
        const didl = decodeXml(tag(res, 'Result') || '');
        const out = [];
        const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRe.exec(didl)) !== null) {
            const uri = tag(m[1], 'res');
            if (!uri) {
                continue; // playlists and other containers
            }
            out.push({
                title: decodeXml(tag(m[1], 'title') || ''),
                uri: decodeXml(uri),
                metadata: decodeXml(tag(m[1], 'resMD') || ''),
            });
        }
        return out;
    }
}

module.exports = { SonosPlayer, SonosError, radioUri, radioMetadata, escapeXml, decodeXml, tag };
