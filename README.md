# Tileprint

**➜ [glysnes.github.io/tileprint](https://glysnes.github.io/tileprint/)**

Del et stort bilde eller en PDF (f.eks. et historisk kart) opp i A4-ark som kan skrives ut på en vanlig hjemmeskriver og limes sammen til en plakat.

Alt skjer i nettleseren. Filen din lastes ikke opp noe sted.

## Funksjoner

- Last opp PNG, JPG, WebP eller PDF (første side, bygges inn som vektor når det går)
- A4, A3 eller Letter, stående, liggende eller automatisk retning
- Velg antall ark (kolonner × rader) eller ønsket størrelse i cm
- Overlapp i mm på valgfrie kanter (standard: høyre og bunn, 10 mm)
- Klippemerker, arknummer og koordinater (A1, B2 …) og valgfri oversiktsside
- Kant-til-kant-modus for skrivere med kantløs utskrift
- Testark for å sjekke at skriveren holder skalaen, og hvor nær kanten den skriver
- Kalibrering etter testarket: egen marg per kant og kompensasjon for skriverens skalafeil
- Forhåndsvisning av hele plakaten og hvert enkelt ark
- Innstillingene huskes i nettleseren

## Slik bruker du den

1. Åpne [siden](https://glysnes.github.io/tileprint/) og velg et bilde eller en PDF.
2. Velg papir, størrelse og overlapp, og sjekk forhåndsvisningen.
3. Trykk **Lag PDF**.
4. Skriv ut med **«Faktisk størrelse» / 100 %**, ikke «Tilpass til side».
5. Klipp bort margen langs klippemerkene på kantene uten overlapp, legg arket over nabo-arkets overlappsfelt og lim.

Usikker på skriveren? Skriv ut testarket først. Kvadratet skal måle nøyaktig 100 × 100 mm.

### Kalibrering

Under **Kalibrer etter testark** kan du skrive inn hva du målte på testarket: kvadratets bredde og høyde, og den første hele streken på hver kant. Tileprint setter da en egen marg for hver kant (det skriveren ikke når ut til, pluss 1 mm) og forhåndsskalerer sidene slik at skriverens skalafeil oppheves. Ved kantløs utskrift brukes målingene til å flytte skjøtene inn forbi det skriveren kutter, mens bildet fortsatt går helt ut i kanten.

Skriv ut et nytt testark etter kalibreringen for å kontrollere den. Det nye arket er skalert på samme måte som plakaten, så kvadratet skal nå måle 100 mm. Er det fortsatt et lite avvik, skriver du bare inn de nye tallene. Kalibreringen lagres i nettleseren, én per papirstørrelse med og uten kantløs utskrift, og blir med når du tilbakestiller de andre innstillingene.

### Kantløs utskrift

Har du en skriver som kan skrive ut uten kanter, kan du krysse av for **Kant til kant**. Velg da kantløs papirstørrelse i skriverdialogen, og slå av forstørrelse hvis driveren har det valget. Mange skrivere støtter kantløs utskrift bare på fotopapir.

## Teknisk

Statisk side uten byggesteg: `index.html`, `style.css` og `app.js` i vanilla JavaScript. [pdf-lib](https://pdf-lib.js.org/) og [pdf.js](https://mozilla.github.io/pdf.js/) lastes fra cdnjs. Siden publiseres med GitHub Pages fra `main`.

Kjør lokalt ved å åpne `index.html`, eller ved å starte en enkel server:

```sh
python3 -m http.server
```

Den opprinnelige spesifikasjonen ligger i [`docs/spec.md`](docs/spec.md).
