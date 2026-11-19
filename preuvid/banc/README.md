# Banc de test KYC — documents français

Mesure la lecture des documents français par le moteur (`engine`) d'Idswyft ou de notre fork.
Images **synthétiques**, identités **fictives** : aucune donnée de vraie personne.

## Contenu

| Fichier | Rôle |
|---|---|
| `gen.py` | Génère 192 images (8 identités × 3 documents × 8 conditions) et `truth.json` (vérité terrain) |
| `run.py` | Envoie chaque image au moteur (`http://127.0.0.1:3002/extract/front` ou `/back`) et écrit `results.jsonl` |
| `score.py` | Compare `results.jsonl` à `truth.json` et affiche les scores par document et par condition |
| `mrz-fr.mjs` | Vérifie que la bibliothèque `mrz` décode les trois formats français (spécimens publics) |
| `scores-reference-idswyft-1.12.39.txt` | Scores du moteur d'origine, le 18/11/2026 : la ligne de base à battre (non reproductible, voir ci-dessous) |
| `resultats-reference-idswyft-1.12.39.jsonl` | Résultats bruts correspondants |

La référence du 18/11 a été mesurée avant le lot 0, avec des versions de Pillow, OpenCV et NumPy non figées
et une image du moteur d'origine qui n'existe plus. Le Dockerfile d'origine installe par `npm install` sans
lockfile, donc chaque construction peut changer les bibliothèques de lecture. Le moteur d'origine construit
le 19/11 depuis les mêmes sources donne, dans le banc conteneurisé, 0 / 64 / 6 / 8 % au lieu de
0 / 69 / 3 / 8 % (`scores/2026-11-19-idswyft-1.12.39.txt`). Le banc conteneurisé, lui, est déterministe sur
la machine de mesure : deux passages donnent les mêmes 256 réponses, au chiffre près.

Documents : CNI 2021 (MRZ TD1, 3×30, au verso), ancienne CNI (2×36, format français), passeport (TD3, 2×44).
Conditions : propre, flou, rotation 7°, perspective, basse résolution, JPEG fort, reflet, sombre + bruit.

## Lancer

Une seule commande, depuis la racine du dépôt (Docker et Python 3 suffisent sur l'hôte) :

```bash
docker compose build engine        # si l'image du moteur n'est pas à jour
python3 preuvid/banc/banc.py       # ~15 min sur 2 cœurs (256 appels)
```

`banc.py` construit l'image du banc (`Dockerfile` : Python, Pillow, OpenCV, NumPy et polices DejaVu
en versions figées), démarre le moteur sur un réseau Docker **interne, sans accès à Internet**,
génère les images, appelle le moteur, calcule les scores et écrit dans `scores/` :

| Fichier | Contenu |
|---|---|
| `AAAA-MM-JJ-<nom>.txt` | scores, avec l'identifiant des images Docker mesurées |
| `AAAA-MM-JJ-<nom>-results.jsonl` | résultats bruts |
| `AAAA-MM-JJ-<nom>-comparaison.txt` | écart avec `resultats-reference-idswyft-1.12.39.jsonl`, appel par appel |

Options : `--moteur IMAGE` (défaut `preuvid/engine:local`), `--nom LIBELLE`, `--reseau-ouvert`
(seulement pour le moteur d'origine, qui télécharge ses modèles au premier appel).
`compare.py A.jsonl B.jsonl` compare deux mesures quelconques.

Lancement manuel, sans Docker pour le banc : `python3 gen.py 8`, puis `ENGINE_URL=http://127.0.0.1:3002 python3 run.py`
et `python3 score.py`. Les images dépendent alors des polices et des versions de Pillow, OpenCV et NumPy
installées : les scores ne sont comparables qu'avec les mêmes versions que `Dockerfile`.

## Modèles du moteur

Depuis le lot 0, le moteur ne télécharge plus rien : PaddleOCR, Tesseract, face-api et les modèles vocaux
sont construits dans l'image depuis `engine/models.manifest.json` (sources épinglées, SHA-256 vérifiée
à la construction et au démarrage). Un modèle absent ou altéré donne une réponse 503 `MODELS_UNAVAILABLE`,
le processus reste debout.

## Limites connues

- Police de la MRZ : DejaVu Sans Mono, pas OCR-B. À remplacer par OCR-B pour coller aux vrais titres.
- Pas de visage : la comparaison de visage et la détection de vivant ne sont pas mesurées ici.
- Pas de faux documents : le score d'authenticité n'est pas mesuré.
- À ajouter : titre de séjour, permis de conduire, vraies pièces fournies avec accord écrit.

## Défauts trouvés sur Idswyft 1.12.39

1. Verso lu par Tesseract : les `<` de la MRZ deviennent des lettres → 0 % sur la CNI 2021.
2. Pas de redressement : rotation 7° ou perspective → 0 % de MRZ lue.
3. Prénoms perdus sur ancienne CNI et passeport (seul le nom remonte, alors que la MRZ les contient).
4. Pas de correction par clés de contrôle (`0` lu `O` dans le numéro).
5. Arrêt du moteur si un téléchargement de modèle échoue.
