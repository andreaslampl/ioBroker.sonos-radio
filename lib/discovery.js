'use strict';

/* Finds Sonos players in the local network via SSDP (UPnP multicast search). */

const dgram = require('node:dgram');

const SEARCH =
    'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\n' +
    'ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n';

/**
 * @param {number} [timeout] ms to wait for answers
 * @returns {Promise<string[]>} host:port of the players that answered
 */
function discover(timeout = 3000) {
    return new Promise(resolve => {
        const found = new Set();
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const done = () => {
            try {
                socket.close();
            } catch {
                // already closed
            }
            resolve([...found]);
        };
        socket.on('error', done);
        socket.on('message', msg => {
            const text = msg.toString();
            if (!/Sonos|ZonePlayer/i.test(text)) {
                return;
            }
            const loc = /^LOCATION:\s*(\S+)/im.exec(text);
            try {
                found.add(new URL(loc[1]).host);
            } catch {
                // no usable location
            }
        });
        socket.bind(0, () => {
            const send = () => socket.send(SEARCH, 1900, '239.255.255.250', () => {});
            send();
            setTimeout(send, 500); // UDP may get lost
            setTimeout(done, timeout);
        });
    });
}

module.exports = { discover };
