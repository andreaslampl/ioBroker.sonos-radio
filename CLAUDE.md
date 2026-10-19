# ioBroker.sonos-radio

ioBroker adapter: web radio on Sonos speakers with a touch page for VIS-2 (owner's Windows
touch PC, same setup as ioBroker.livecam's camera wall). Local UPnP/SOAP on port 1400, no cloud,
no dependency on the sonos adapter.

## Layout

- `main.js` – adapter: station table, `rooms.<id>.{station,playing,volume,title,group,online}`,
  writes from ioBroker -> Radio commands, `info.pageUrl`.
- `lib/sonos.js` – `SonosPlayer`: SOAP calls (AVTransport, RenderingControl, ZoneGroupTopology,
  ContentDirectory), topology (skips Invisible bonded subs/surrounds), favorites (FV:2),
  now playing (`r:streamContent`). `radioUri`: http -> `x-rincon-mp3radio://`, https unchanged.
- `lib/discovery.js` – SSDP search for ZonePlayer.
- `lib/radio.js` – `Radio`: rooms from topology (any reachable player or discovery), serialized
  commands, polling. Source per station: Sonos favorite with same/containing name first, then URL.
  Play: lead room leaves its group if it is a member, unselected members of its group leave, then
  SetAVTransportURI + Play, other rooms join with `x-rincon:<uuid>`. Stop: member leaves group,
  lead with other members hands the group over (BecomeCoordinatorOfStandaloneGroup) then stops.
  Command errors are shown on the page, so they are German.
- `lib/server.js`, `lib/page.js` – `/radio` touch page (room chips, station tiles, volume rows),
  `/status`, `/ws` (status push, play/stop/volume commands).
- `test/` – `node --test` against `test/fake-sonos.js` (simulated household: only coordinators
  accept URI/Play -> 800, Stop without URI -> 701, group hand-over).

## Field status

- Owner's rooms: Fernsehzimmer, Küche, Terrasse. Stations: Radio 88.6, Ö3, Kronehit, Welle 1,
  Antenne Kärnten. Default stream URLs come from public lists and were not verifiable from the
  build environment; Sonos favorites are the recommended source.
- Not yet tested against real Sonos hardware.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.sonos-radio`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
