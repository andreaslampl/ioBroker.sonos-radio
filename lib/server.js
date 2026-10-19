'use strict';

/*
 * Web server for the touch PC / VIS-2:
 *   /radio    radio page (station tiles, rooms, volume)
 *   /status   current status as JSON
 *   /ws       WebSocket: status pushes, commands from the page
 */

const http = require('node:http');
const { WebSocketServer } = require('ws');
const { renderPage } = require('./page');

class RadioServer {
    /**
     * @param {object} options
     * @param {import('./radio').Radio} options.radio
     * @param {object} options.log
     */
    constructor({ radio, log }) {
        this.radio = radio;
        this.log = log;
        this.server = http.createServer((req, res) => this._handle(req, res));
        this.wss = new WebSocketServer({ noServer: true });
        this.server.on('upgrade', (req, socket, head) => {
            if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, ws => this._client(ws));
        });
        this.onStatus = st => this._broadcast({ type: 'status', ...st });
        radio.on('status', this.onStatus);
    }

    listen(port, host = '0.0.0.0') {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', reject);
                resolve(this.server.address());
            });
        });
    }

    close() {
        this.radio.removeListener('status', this.onStatus);
        for (const ws of this.wss.clients) {
            ws.terminate();
        }
        this.server.closeAllConnections();
        return new Promise(resolve => this.server.close(() => resolve()));
    }

    _handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/radio' || url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(renderPage(this.radio.status()));
            return;
        }
        if (url.pathname === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(this.radio.status()));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }

    _send(ws, msg) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(msg));
        }
    }

    _broadcast(msg) {
        for (const ws of this.wss.clients) {
            this._send(ws, msg);
        }
    }

    _client(ws) {
        this._send(ws, { type: 'status', ...this.radio.status() });
        ws.on('message', async data => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            try {
                if (msg.type === 'play') {
                    await this.radio.play(msg.rooms || [], msg.station);
                } else if (msg.type === 'stop') {
                    await this.radio.stop(msg.rooms || []);
                } else if (msg.type === 'volume') {
                    await this.radio.setVolume(msg.room, msg.volume);
                }
            } catch (err) {
                this.log.warn(err.message);
                this._send(ws, { type: 'error', message: err.message });
            }
        });
    }
}

module.exports = { RadioServer };
