# Direction visuelle : « papier fiduciaire »

L'univers d'une pièce d'identité, pas celui d'un logiciel. Un seul élément fort : la rosace guillochée.

| Jeton | Valeur | Usage |
|---|---|---|
| Papier | `#F2F3EE` | Fond clair |
| Encre | `#0F1F1A` | Texte, fonds sombres |
| Encre douce | `#45544E` | Texte secondaire |
| Filet | `#C7CCC4` | Séparateurs |
| Tampon | `#47307E` | Accent unique, action principale |
| Ambre | `#7A4E00` | Avertissement |
| Vert | `#1B6245` | Validé |
| Blanc cassé | `#FBFBF8` | Champs, cartes |

- **Titres** : Archivo, axe de largeur à 125 %, graisse 600, interlettrage serré.
- **Texte** : Archivo, largeur normale.
- **Machine** : IBM Plex Mono, réservé aux données de machine (MRZ, identifiants, empreintes, prix, code, tampon).
- **Boutons** : coin supérieur droit coupé (`clip-path`), pas d'arrondi. Arrondi réservé aux objets « carte ».
- **Libellés** en bas de casse, pas de sur-titres décoratifs, pas de numérotation sauf vraie séquence.
- **Menus** : cinq entrées au plus par espace.
- **Mouvement** : la rosace tourne lentement, anneau par anneau ; au survol elle pivote et passe au violet.
  Barres qui montent, lignes qui se décalent, tampon qui tombe sur le résultat. Tout s'arrête avec
  `prefers-reduced-motion`.
- **Données** : aucun nom dans les listes ; le motif d'un statut passe avant le reste ; photos masquées par défaut.

Le code des maquettes (`preuvid/maquettes/*.html`) contient les styles et la génération de la rosace :
s'en servir comme référence, puis en faire des composants React.
