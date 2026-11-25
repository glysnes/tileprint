# Plakat-splitter

En statisk nettside som deler et stort bilde eller en PDF (f.eks. et historisk kart) opp i flere A4-ark som kan skrives ut på vanlig hjemmeskriver og settes sammen til en stor plakat.

## Mål

Brukeren laster opp et bilde eller en PDF, velger hvor mange ark plakaten skal bestå av (eller ønsket størrelse), og får en PDF der hver side er ett ark. Sidene har overlapp i kantene slik at de kan limes sammen med en justeringskant.

## Funksjonalitet

- Opplasting av bilde (PNG, JPG) og PDF (første side)
- Valg av papirstørrelse: A4 (standard), evt. A3 og Letter
- Valg av rutenett: antall kolonner og rader, eller målbredde og -høyde i cm, med automatisk beregning
- Overlapp i mm per kant (standard 10 mm), med valg av hvilke kanter som skal ha overlapp (høyre og bunn som standard)
- Valgfrie klippemerker i hjørnene av hvert ark
- Valgfri sidenummerering og rutenettkoordinater (f.eks. "A2 / 3×4") for å holde orden under limingen
- Forhåndsvisning av rutenettet før eksport
- Eksport til én PDF med ett ark per side, skalert 1:1 slik at den kan skrives ut uten tilpasning
- Advarsel ved veldig store filer (over ca. 50 MB eller over ca. 6000 px bredde) om at nettleseren kan bli treg

## Tekniske krav

- Én statisk `index.html` med eventuell tilhørende CSS og JS. Ingen backend.
- Skal kjøre på GitHub Pages.
- Alt skjer i nettleseren. Filene skal ikke lastes opp til noen server.
- Bruk vanilla JavaScript. Hvis en bibliotek trengs, for eksempel `pdf-lib` for PDF-generering, lastes det via CDN.
- Må fungere i nyere versjoner av Chrome, Edge, Firefox og Safari.
- Ingen avhengigheter som krever bygg- eller installasjonssteg.
- Språk i grensesnittet: norsk (bokmål).

## Akseptkriterier

- Et testbilde på ca. 5000×7000 px kan deles i 3×4 ark med 10 mm overlapp, og PDF-en skrives ut med riktig størrelse på en vanlig A4-skriver.
- Overlappet på hver side er nøyaktig det som er valgt i mm.
- Forhåndsvisningen stemmer med det som havner i PDF-en.
- Siden fungerer uten feilmeldinger i konsollen.

## Åpne spørsmål

- Skal klippemerker være på som standard, eller av?
- Skal overlappet være på høyre og nedre kant, eller skal brukeren velge selv?
- Skal siden kunne lagre innstillinger i nettleseren (localStorage)?

## Forslag til arbeidsrekkefølge

1. Lag en enkel fungerende versjon med opplasting, rutenett og PDF-eksport uten overlapp.
2. Legg til overlapp og klippemerker.
3. Legg til forhåndsvisning.
4. Legg til advarsler, sidenummerering og innstillinger.
5. Test med et stort bilde og en vanlig skriver.
