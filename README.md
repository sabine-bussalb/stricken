# Stricken

Eine Strick-App für das iPad: Projekte, Anleitungen (PDF, Fotos, Text), Reihenzähler, Fahrplan mit Erinnerungen.
Läuft im Safari und als App auf dem Home-Bildschirm, auch offline. **Alle Daten bleiben auf dem iPad.**

## Einrichten (einmalig)

1. Auf GitHub im Repository auf **Settings → Pages** gehen.
2. Bei „Build and deployment“ als Quelle **Deploy from a branch** wählen, dann den Branch **`main`** und den Ordner **/ (root)** auswählen und speichern.
3. Nach ein bis zwei Minuten steht oben die Adresse, z. B. `https://DEIN-NAME.github.io/stricken/`.
4. Diese Adresse auf dem iPad in **Safari** öffnen.
5. Auf **Teilen** (Quadrat mit Pfeil) tippen → **Zum Home-Bildschirm** → **Hinzufügen**.
6. Ab jetzt die App über das Symbol auf dem Home-Bildschirm öffnen.

## Wichtig zu wissen

- Die Daten liegen nur auf diesem iPad, in genau dieser App. Safari und die Home-Bildschirm-App haben **getrennte** Speicher. Nutze am besten immer das Symbol auf dem Home-Bildschirm.
- Mach regelmäßig eine **Sicherung** (Knopf „Sicherung“ auf der Startseite) und lege sie in iCloud Drive ab.
- Wenn du die App vom Home-Bildschirm löschst, sind die Daten weg. Vorher sichern!

## Für Änderungen an der App

Nach jeder Änderung in `sw.js` die Zeile `const VERSION = 'stricken-v1';` hochzählen (v2, v3 …), damit das iPad die neue Version lädt. Die App muss danach ein- bis zweimal neu geöffnet werden.

Verwendet: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), Schrift [Nunito](https://fonts.google.com/specimen/Nunito) (SIL OFL).
