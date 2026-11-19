#!/usr/bin/env python3
"""Banc de lecture en une commande.

    python3 preuvid/banc/banc.py                       # moteur construit par docker compose
    python3 preuvid/banc/banc.py --moteur IMAGE --nom LIBELLE
    python3 preuvid/banc/banc.py --moteur preuvid-engine:idswyft-1.12.39 \\
        --nom idswyft-1.12.39 --reseau-ouvert          # moteur d'origine (télécharge ses modèles)

Déroulé, entièrement dans Docker pour que le résultat ne dépende pas de la
machine (polices, versions de Pillow/OpenCV) :
  1. construit l'image du banc (preuvid/banc/Dockerfile, versions figées) ;
  2. démarre le moteur sur un réseau Docker interne, sans accès à Internet
     (sauf --reseau-ouvert, nécessaire au moteur d'origine) ;
  3. génère les 192 images, envoie les 256 appels, calcule les scores ;
  4. écrit dans preuvid/banc/scores/ :
       AAAA-MM-JJ-<nom>.txt               scores (avec images Docker utilisées)
       AAAA-MM-JJ-<nom>-results.jsonl     résultats bruts
       AAAA-MM-JJ-<nom>-comparaison.txt   écart avec la référence, appel par appel
  5. arrête le moteur et supprime le réseau.

Seule dépendance sur l'hôte : Docker et Python 3 (bibliothèque standard).
"""
import argparse
import datetime as dt
import pathlib
import subprocess
import sys

ICI = pathlib.Path(__file__).resolve().parent
SCORES = ICI / 'scores'
IMAGE_BANC = 'preuvid/banc:local'
RESEAU = 'preuvid-banc'
MOTEUR = 'preuvid-banc-moteur'
REFERENCE = 'resultats-reference-idswyft-1.12.39.jsonl'


def docker(*args, check=True, capture=False):
    return subprocess.run(
        ['docker', *args],
        check=check,
        text=True,
        encoding='utf-8',
        capture_output=capture,
    )


def image_id(image):
    r = docker('image', 'inspect', '--format', '{{.Id}}', image, check=False, capture=True)
    return r.stdout.strip() if r.returncode == 0 else None


def nettoyer():
    docker('rm', '-f', MOTEUR, check=False, capture=True)
    docker('network', 'rm', RESEAU, check=False, capture=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--moteur', default='preuvid/engine:local', help="image du moteur à mesurer")
    p.add_argument('--nom', default=None, help="libellé des fichiers de scores (défaut : dérivé de l'image)")
    p.add_argument('--reference', default=REFERENCE, help="résultats de référence (dans preuvid/banc/)")
    p.add_argument('--reseau-ouvert', action='store_true',
                   help="laisser le moteur accéder à Internet (moteur d'origine uniquement)")
    p.add_argument('--n', type=int, default=8, help="nombre d'identités (défaut 8, soit 192 images)")
    a = p.parse_args()

    if not image_id(a.moteur):
        sys.exit(f"Image du moteur introuvable : {a.moteur}. Construire d'abord : docker compose build engine")

    nom = a.nom or a.moteur.replace('/', '-').replace(':', '-')
    jour = dt.date.today().isoformat()
    base = f'{jour}-{nom}'
    SCORES.mkdir(exist_ok=True)

    print(f'[banc] construction de {IMAGE_BANC}')
    docker('build', '-q', '-t', IMAGE_BANC, str(ICI))

    nettoyer()
    try:
        reseau = ['network', 'create'] + ([] if a.reseau_ouvert else ['--internal']) + [RESEAU]
        docker(*reseau, capture=True)
        print(f"[banc] moteur {a.moteur} sur le réseau {RESEAU} "
              f"({'accès Internet' if a.reseau_ouvert else 'sans accès Internet'})")
        docker('run', '-d', '--name', MOTEUR, '--network', RESEAU,
               '--memory', '3g', '--cpus', '2',
               '-e', 'NODE_ENV=production', '-e', 'PORT=3002', a.moteur, capture=True)

        url = f'http://{MOTEUR}:3002'
        script = f"""
set -e
for i in $(seq 1 180); do curl -sf {url}/health >/dev/null && break; sleep 1; done
curl -sf {url}/health >/dev/null || {{ echo "moteur injoignable"; exit 1; }}
python gen.py {a.n} >/dev/null
: > results.jsonl
python run.py
python score.py > /sortie/{base}.scores
cp results.jsonl /sortie/{base}-results.jsonl
if [ -f /depot/{a.reference} ]; then
  python compare.py /depot/{a.reference} results.jsonl > /sortie/{base}-comparaison.txt
fi
"""
        print('[banc] génération, 256 appels au moteur, scores (environ 15 min)')
        docker('run', '--rm', '--network', RESEAU,
               '-e', f'ENGINE_URL={url}',
               '-v', f'{SCORES}:/sortie',
               '-v', f'{ICI}:/depot:ro',
               IMAGE_BANC, 'sh', '-c', script)
    finally:
        journal = docker('logs', '--tail', '200', MOTEUR, check=False, capture=True)
        if journal.returncode == 0:
            (SCORES / f'{base}-moteur.log').write_text(
                (journal.stdout or '') + (journal.stderr or ''), encoding='utf-8')
        nettoyer()

    brut = SCORES / f'{base}.scores'
    entete = (
        f'# Banc Preuvid — {jour}\n'
        f'# moteur : {a.moteur} ({image_id(a.moteur)})\n'
        f'# banc   : {IMAGE_BANC} ({image_id(IMAGE_BANC)})\n'
        f"# réseau : {'ouvert' if a.reseau_ouvert else 'interne, sans Internet'}\n\n"
    )
    sortie = SCORES / f'{base}.txt'
    sortie.write_text(entete + brut.read_text(encoding='utf-8'), encoding='utf-8')
    brut.unlink()
    print(sortie.read_text(encoding='utf-8'))
    comp = SCORES / f'{base}-comparaison.txt'
    if comp.exists():
        print(comp.read_text(encoding='utf-8'))
    print(f'[banc] fichiers écrits dans {SCORES}')


if __name__ == '__main__':
    main()
