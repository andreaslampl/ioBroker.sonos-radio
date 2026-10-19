# ioBroker.sonos-radio

Webradio auf **Sonos**-Lautsprechern, mit einer großen **Touch-Seite für VIS-2**:
Raum antippen, Sender antippen, fertig. Mehrere Räume gleichzeitig ausgewählt = sie spielen
gemeinsam (gruppiert). Lautstärke pro Raum, Stopp, Anzeige des laufenden Titels.

Die Steuerung läuft direkt über das lokale Netzwerk (UPnP, Port 1400), ohne Cloud und ohne
weiteren Adapter.

## Installation

Auf dem ioBroker-Server:

```
iob url https://github.com/andreaslampl/ioBroker.sonos-radio
```

Danach im Admin unter **Adapter** eine Instanz von **sonos-radio** anlegen.

## Einstellungen

### Reiter „Sender“

| Spalte | Bedeutung |
| --- | --- |
| Aktiv | Sender auf der Radio-Seite anzeigen |
| Name | Name auf der Kachel, z. B. `Ö3` |
| Stream-Adresse | direkte Adresse des Radio-Streams (MP3/AAC) |
| Sonos-Favorit | optional: Name des Favoriten in der Sonos-App, falls er anders heißt |
| Logo-Adresse | optional: Bild statt Text auf der Kachel |
| Farbe | Farbe der Kachel |

Voreingestellt sind Radio 88.6, Ö3, Kronehit, Welle 1 und Antenne Kärnten.

**Tipp (am zuverlässigsten):** die Sender in der **Sonos-App als Favoriten** speichern
(„Zu Meine Sonos hinzufügen“). Heißt ein Favorit so wie der Sender oder enthält er den Namen
(z. B. Favorit „Hitradio Ö3“ für den Sender „Ö3“), spielt der Adapter genau diesen Favoriten.
Die Stream-Adresse ist dann nur Ersatz. Die voreingestellten Adressen stammen aus öffentlichen
Listen und können sich ändern.

### Reiter „Sonos und Webserver“

| Einstellung | Bedeutung |
| --- | --- |
| IP eines Sonos-Lautsprechers | leer = automatisch suchen; ein Lautsprecher reicht, alle Räume werden darüber gefunden |
| Aktualisierung | wie oft Status und Titel abgefragt werden (Standard 4 s) |
| Port | Port der Radio-Seite (Standard **8096**) |

Wird kein Lautsprecher gefunden (steht im Log), die IP eines Sonos-Lautsprechers eintragen,
z. B. aus der Sonos-App unter *Einstellungen → System → Info zu meinem System*.

## In VIS-2 einbinden

Ein Widget **Basic → HTML** auf die Seite ziehen, auf die gewünschte Größe ziehen und eintragen
(`x.x.x.x` = IP des ioBroker-Servers, die fertige Adresse steht im Datenpunkt
`sonos-radio.0.info.pageUrl`):

```html
<iframe src="http://x.x.x.x:8096/radio" style="width:100%;height:100%;border:0"></iframe>
```

Zusätze an der Adresse:

| Zusatz | Wirkung | Beispiel |
| --- | --- | --- |
| `rooms=` | diese Räume sind beim Öffnen ausgewählt | `?rooms=kueche,terrasse` |
| `cols=` | Anzahl Spalten der Senderkacheln | `?cols=3` |

Die Seite merkt sich die zuletzt gewählten Räume. Nach einem Neustart des Adapters lädt sie sich
selbst neu.

## Bedienung

- **Raum antippen:** auswählen bzw. abwählen. Mehrere Räume = spielen gemeinsam.
- **Sender antippen:** spielt in allen ausgewählten Räumen. Ein Raum, der vorher mit anderen
  gruppiert war, wird dabei aus der Gruppe genommen.
- **Stopp:** stoppt die ausgewählten Räume; andere Räume derselben Gruppe spielen weiter.
- **Lautstärke:** Schieberegler oder − / + pro ausgewähltem Raum.

## Datenpunkte

Pro Raum unter `sonos-radio.0.rooms.<raum>` (z. B. `rooms.kueche`):

| Datenpunkt | Bedeutung |
| --- | --- |
| `station` | laufender Sender; **Sendername hineinschreiben = abspielen**, leer = Stopp |
| `playing` | spielt; `false` = Stopp, `true` = letzten Sender wieder abspielen |
| `volume` | Lautstärke 0–100 (schreibbar) |
| `title` | aktueller Titel, falls der Sender ihn mitschickt |
| `group` | spielt zusammen mit diesen Räumen |
| `online` | Lautsprecher erreichbar |

Damit geht auch Automatik per Skript oder Szene, z. B. morgens um 7 Uhr in der Küche Ö3
(`rooms.kueche.station` = `Ö3`) und abends alles aus.

## Entwicklung

```
npm install
npm test
```

Die Tests laufen gegen einen simulierten Sonos-Haushalt (`test/fake-sonos.js`).

## Lizenz

MIT
