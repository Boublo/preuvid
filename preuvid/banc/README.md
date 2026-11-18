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
| `scores-reference-idswyft-1.12.39.txt` | Scores du moteur d'origine, le 18/11/2026 : la ligne de base à battre |
| `resultats-reference-idswyft-1.12.39.jsonl` | Résultats bruts correspondants |

Documents : CNI 2021 (MRZ TD1, 3×30, au verso), ancienne CNI (2×36, format français), passeport (TD3, 2×44).
Conditions : propre, flou, rotation 7°, perspective, basse résolution, JPEG fort, reflet, sombre + bruit.

## Lancer

```bash
pip install pillow numpy opencv-python-headless
python3 gen.py 8                 # crée img/ et truth.json (graine fixe : résultats reproductibles)

# moteur seul, sans exposer le port ailleurs qu'en local
docker run -d --name kyc-engine --memory 3g --cpus 2 \
  -e NODE_ENV=production -e PORT=3002 \
  -p 127.0.0.1:3002:3002 <image du moteur>

: > results.jsonl
python3 run.py                   # ~15 min sur 2 cœurs (256 appels)
python3 score.py
```

`run.py` reprend là où il s'est arrêté (il saute les clés déjà présentes dans `results.jsonl`).
Vider `results.jsonl` avant chaque nouvelle mesure.

## Ce que le moteur d'origine demande au premier appel

Il télécharge ses modèles au premier document et **s'arrête** si le téléchargement échoue :

- Tesseract : `eng.traineddata.gz` depuis `cdn.jsdelivr.net`
- PaddleOCR : `PP-OCRv5_mobile_det_infer.onnx`, `en_PP-OCRv5_mobile_rec_infer.onnx`, `ppocrv5_en_dict.txt`
  depuis `github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models`, mis en cache dans `~/.cache/ppu-paddle-ocr`

Dans notre fork, ces modèles doivent être embarqués dans l'image et vérifiés par empreinte.

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
