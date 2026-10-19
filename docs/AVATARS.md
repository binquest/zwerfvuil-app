# Avatars tekenen

Voor wie de tekeningen maakt; je hoeft niets van de code te weten. Tot er een tekening is, toont
de app een placeholder: een symbool op een gekleurde cirkel. Zodra jouw PNG in de app zit, verschijnt
die tekening overal waar die avatar staat: ranglijst, profiel, avatar-kiezer en onboarding.

## Wat er te tekenen is

Twaalf avatars, de reisgenoten die spelers kiezen, en de mascotte **Zwerfie**. Zwerfie is geen
avatar: geen enkele speler draagt hem. Hij verwelkomt je in de onboarding en staat later op lege
schermen.

| Bestand | Naam | Hoe krijg je hem | Zeldzaamheid | Cirkelkleur |
|---|---|---|---|---|
| `spruit.png` | Spruit | meteen (standaard) | gewoon | `#4E9A52` |
| `vos.png` | Vos | meteen | gewoon | `#C8553D` |
| `zon.png` | Zon | meteen | gewoon | `#C9821A` |
| `berg.png` | Berg | meteen | gewoon | `#6B7A8F` |
| `bloem.png` | Bloem | level 5 | zeldzaam | `#C2508A` |
| `bliksem.png` | Bliksem | level 8 | zeldzaam | `#7B4FD0` |
| `eik.png` | Eik | level 12 | episch | `#6E5338` |
| `haas.png` | Haas | 50 vuilbakken ontdekt | zeldzaam | `#A0794F` |
| `schildpad.png` | Schildpad | 100 vuilbakken ontdekt | episch | `#2C7A7B` |
| `merel.png` | Merel | badge Vroege vogel (inworp vóór 8 uur) | zeldzaam | `#3D3D4E` |
| `maan.png` | Maan | alleen uit de dagkist | episch | `#2F3A7A` |
| `regenboog.png` | Regenboog | alleen uit de dagkist | legendarisch | `#1F9BD1` |
| `zwerfie.png` | Zwerfie (mascotte) | — | — | `#23A465` |

Spruit is de standaardavatar: die krijgt iemand die (nog) niets koos. De haas en de schildpad horen
bij elkaar (de fabel): de haas komt eerst, de schildpad wint op 100.

## Het bestand

- **PNG met transparantie** (RGBA), in sRGB.
- **512 × 512 pixels**, precies.
- **Achtergrond volledig transparant.** Teken alleen het figuur: de app zet het zelf op een
  cirkel in de kleur uit de tabel. De vier hoekpixels moeten 100 % transparant zijn.
- **Binnen de cirkel blijven.** De app knipt de tekening rond. Houd het figuur binnen een cirkel van
  464 px in het midden (24 px marge rondom); alles daarbuiten valt (deels) weg.
- **Bestandsnaam = de key uit de tabel**, in kleine letters: `vos.png`, niet `Vos.png` of
  `vos-def.png`.
- **Hoogstens 200 KB.** Te groot? Haal het door [TinyPNG](https://tinypng.com) of exporteer met
  minder kleuren; een PNG met een palet en transparantie is prima.

## Stijl: leesbaar van 28 tot 96 punten

De ranglijst toont een avatar op 28 tot 40 punten (de grootte van een vingertop), de kiezer op ±76
en het profiel op ±104. Op 28 punten is je tekening nog ±84 echte pixels breed: zes keer kleiner dan
je bestand.

- **Eén sterk silhouet.** In de kiezer zie je een vergrendelde avatar als effen grijze vorm (alle
  niet-transparante pixels in één kleur). Test: vul je figuur helemaal zwart. Herken je nog een vos,
  een berg, een bliksem? Dan is het goed.
- **Groot en eenvoudig.** Het figuur vult ±80 % van de cirkel. Lijnen minstens 12 px dik, details
  minstens 24 px; fijnere dingen verdwijnen op 28 punten.
- **Een donkere contour** van 12 à 16 px rond het figuur, zodat het loskomt van de cirkel (en van
  andere avatars ernaast).
- **Weinig kleuren** (3 tot 5), vlakke vullingen. Geen verlopen, fijne texturen of tekst.
- **Contrast met de eigen cirkelkleur** uit de tabel (die is gelijk in licht en donker modus). Lijkt
  een kleur niet te passen, vraag ze dan aan te passen: dat kan zonder app-update.
- **Geen schaduw of gloed buiten het figuur.** Halftransparante pixels worden in het silhouet een
  vage rand. Transparantie alleen op de randen (anti-aliasing), niet binnen het figuur.
- **Een gezicht of een blik**, zodat het een reisgenoot is ("Vos gaat met je mee."), en allemaal in
  dezelfde stijl en lijndikte.
- **Zwerfie** verschijnt groter (96 tot 112 punten), dus daar mag iets meer detail in, met dezelfde
  regels.

## Daarna

1. Je bezorgt de PNG's aan de ontwikkelaar, met de bestandsnamen uit de tabel. Eén of een paar tegelijk
   kan ook: avatars zonder tekening houden hun placeholder.
2. De ontwikkelaar zet ze in `app/assets/avatars/` en draait `npm --prefix app run avatars`. Dat
   script controleert alle regels hierboven (formaat, afmetingen, transparante hoeken, grootte,
   naam), weigert een bestand met de reden, en maakt kleine versies van 192 × 192 voor de lijsten
   en de lijst die de app gebruikt. Een test faalt als iemand het script vergat te draaien.
3. De ontwikkelaar draait de tests, commit, en publiceert een EAS Update
   (`npm --prefix app run update:dev`). Er is geen nieuwe app-installatie nodig: de tekeningen
   staan op de iPhone na de volgende herstart van de app.

Een **nieuwe** avatar (een dertiende) vraagt ook een rij in de tabel `avatars` op de server (naam,
zeldzaamheid, hoe je hem krijgt, cirkelkleur, placeholder): dat doet de ontwikkelaar met een migratie.
Zonder die rij toont de app de tekening nergens. Een andere cirkelkleur of naam is alleen een
wijziging in die tabel, zonder app-update.
