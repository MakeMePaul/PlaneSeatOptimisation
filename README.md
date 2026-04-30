# AeroBoard

AeroBoard ist eine GitHub-Pages-kompatible Websimulation fuer Flugzeug-Boarding (Top-Down-Ansicht, 30 Reihen).  
Das Projekt ist modular aufgebaut, damit spaeter Python-Optimierung, Familienlogik, Seat-Interference und echte Cluster-Verfahren ergaenzt werden koennen.

## Projektstruktur

- `index.html` UI-Struktur und Controls
- `style.css` Layout und Darstellung
- `app.js` Kernlogik (Passenger, Plane, Simulation, Rendering, UI-Events)
- `algorithms.js` Boarding-Strategien
- `backend/main.py` Platzhalter fuer spaeteres FastAPI-Backend

## Lokaler Start

Da keine Libraries und kein Build-System verwendet werden, reicht ein statischer Webserver:

```powershell
python -m http.server 8000
```

Danach im Browser oeffnen:

`http://localhost:8000`

Alternativ kann `index.html` direkt geoeffnet werden; empfohlen ist trotzdem ein lokaler Server.

## GitHub Pages Deployment

1. Repository nach GitHub pushen.
2. In GitHub unter `Settings -> Pages` als Source den Branch (z. B. `main`) und das Root-Verzeichnis (`/`) auswaehlen.
3. Speichern und auf die veroeffentlichte URL warten.

Da das Frontend nur aus statischen Dateien besteht, ist es ohne weitere Anpassungen GitHub-Pages-faehig.

## Enthaltene Boarding-Algorithmen

- `random`
- `backToFront`
- `windowMiddleAisle`
- `prototypeCluster`

Die Implementierungen liegen in `algorithms.js` und koennen unabhaengig von Rendering/UI erweitert oder ersetzt werden.  
Die Algorithmen sind gruppenbewusst vorbereitet: Passagiere werden zuerst nach `groupId` gebuendelt und nur als Gruppe sortiert, sodass Gruppen nicht getrennt werden.  
Passagiere ohne `groupId` werden als Einzelgruppen behandelt (`groupId` standardmaessig `null`).

## Passenger Profiles

- Profile: `business`, `standard`, `elderly`, `child`, `heavy_luggage`
- Option in der UI: `Passagierprofile aktivieren` (standardmaessig aktiv)
- Profile beeinflussen nur Verhalten (z. B. `stowTime`, `moveCooldown`) und Tooltip-Informationen
- Farben werden deterministisch aus `clusterId` abgeleitet (algorithmusabhaengig)
- `groupId` bleibt pro Passenger erhalten und ist fuer spaetere Familienlogik vorbereitet

## Seat Occupancy Modell

- `Plane` verwaltet jetzt sowohl `aisle` als auch echte Sitzbelegung (`seats[row][seatLetter]`).
- Wenn ein Passenger mit Stowing fertig ist, wird er in seinen Ziel-Sitz ueberfuehrt und der Gang-Slot wird frei.
- Die Statistik `Sitzend` basiert auf der aktuell belegten Sitzanzahl (`getOccupiedSeatsCount()`).
- Seat-Interference/Blockaden sind implementiert: nach `stowing` folgt bei Bedarf `seating`, bevor `seated` gesetzt wird.

## Feature-Status

- Zustandskette: `waiting -> walking -> stowing -> seating -> seated` (implementiert)
- Seat Occupancy (`seats[row][seatLetter]`) (implementiert)
- Seat Interference (Fenster/Mitte/Gang-Regeln) (implementiert)
- Profile (`stowTime`, `moveCooldown`) (implementiert)
- Familien-/Gruppenlogik (vorbereitet, noch kein eigener Generator)
- Python/FastAPI-Backend-Anbindung (geplant)

## Cluster- und Fallback-Regeln

- `random`: alle Passagiere in Cluster `random` (neutrale Farbe)
- `backToFront`: `zone_back` (Reihen 21-30), `zone_middle` (11-20), `zone_front` (1-10)
- `windowMiddleAisle`: `window` (A/F), `middle` (B/E), `aisle` (C/D)
- `prototypeCluster`: `cluster_1` (1-8), `cluster_2` (9-16), `cluster_3` (17-24), `cluster_4` (25-30)
- Wenn ein Algorithmus fehlt, faellt die Simulation auf `random` zurueck und gibt eine Warnung in der Konsole aus.

## Roadmap

- Familien-/Gruppenregeln mit zusammenhaengendem Boarding
- Seat-Interference (z. B. Blockieren auf Fenster-/Mittelsitzen)
- Erweiterte Clusterverfahren und externe Optimierer
- FastAPI-Backend in `backend/main.py` als Simulations- und Optimierungs-API
