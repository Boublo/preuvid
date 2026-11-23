# Lecture de la puce NFC depuis un navigateur mobile : étude de faisabilité (lot 3)

Question : peut-on lire la puce de la CNI 2021 ou du passeport depuis une page web sur téléphone, sans appli ?

**Avis : impossible depuis un navigateur aujourd'hui ; possible avec une appli.** Le parcours web du lot 3
n'utilise donc pas la puce. La puce reste une piste pour une appli mobile, à décider plus tard.

Relevé du 20/11/2026. À revérifier avant toute décision d'appli : les navigateurs évoluent.

## Ce qu'il faudrait pour lire la puce

La CNI 2021 et le passeport suivent la norme ICAO 9303. La lecture demande :

- un échange de commandes de carte à puce (ISO 7816-4 sur ISO 14443, « ISO-DEP ») ;
- l'ouverture d'un canal chiffré : PACE avec le numéro d'accès de la carte (CAN, six chiffres imprimés au
  recto de la CNI) ou avec la bande MRZ ; BAC sur les anciens passeports ;
- pour faire confiance aux données, la vérification de leur signature avec les certificats de l'État
  émetteur (liste maîtresse CSCA). C'est ce qui rend la puce plus sûre qu'une photo.

Il faut donc un accès bas niveau à la puce, pas seulement la lecture d'une étiquette.

## Navigateurs

| Plateforme | Web NFC | Lecture de la puce |
|---|---|---|
| Chrome sur Android | Oui, mais limité au format NDEF (étiquettes simples). Pas d'ISO-DEP. | **Non.** Présenter un passeport pendant une lecture NDEF renvoie une erreur « étiquette non prise en charge ». |
| Safari sur iPhone | Non. WebKit s'y déclare opposé. | **Non.** |
| Firefox | Non, Mozilla s'y déclare opposé. | **Non.** |

L'ISO-DEP figure dans les travaux futurs de Chromium, sans calendrier. Un prototype tiers existe derrière un
drapeau dans une version modifiée de Chromium : ce n'est pas utilisable par le public.

## Appli native

- **Android** : l'API `IsoDep` donne l'accès nécessaire. Des bibliothèques libres font déjà PACE et BAC.
- **iPhone** : Core NFC lit les puces ISO 7816, passeports compris (déclaration des identifiants
  d'application dans l'appli). Apple a de plus ouvert le NFC aux applis tierces depuis iOS 18.1.
- Les fournisseurs du marché (Didit par exemple) passent par leur kit natif pour la puce ; leurs parcours
  web s'en passent.

Coût d'une appli : deux applis à publier et maintenir, revue des magasins, et la personne doit installer
une appli pour une vérification, ce qui va contre l'idée « sans appli » du parcours âge.

## Conséquences pour le lot 3

- Première vérification de l'âge : pièce photographiée (lecture déjà au banc), estimation par le visage
  seulement si ses conditions sont remplies (voir `verification-age.md`).
- L'écran 08 n'affiche pas d'option puce.
- À rouvrir si Chrome publie l'ISO-DEP, ou si David décide d'une appli.

## Sources

- [Chrome for Developers : Web NFC](https://developer.chrome.com/docs/capabilities/nfc) (NDEF seulement)
- [Chromium : document de conception Web NFC](https://www.chromium.org/developers/design-documents/web-nfc/) (ISO-DEP en travaux futurs)
- [Proposition tierce NFCIsoDepReader](https://github.com/johan-sellstrom/web-nfc-iso-dep) (prototype, non publié)
- [Can I use : Web NFC](https://caniuse.com/webnfc) ; [Web features explorer](https://web-platform-dx.github.io/web-features-explorer/features/web-nfc)
- [Liste W3C public-web-nfc, janvier 2024](https://lists.w3.org/Archives/Public/public-web-nfc/2024Jan/0000.html) (positions de Mozilla et WebKit)
- [Android : IsoDep](https://developer.android.com/reference/android/nfc/tech/IsoDep)
- [Didit : lecture NFC](https://didit.me/products/nfc-verification/) (kit natif)
