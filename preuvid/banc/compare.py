"""Compare deux fichiers de résultats du banc, appel par appel.

    python3 compare.py reference.jsonl mesure.jsonl

Affiche, par document, l'écart du score TOUT et la liste des images dont le
verdict ou les lignes MRZ brutes ont changé. Code de sortie 0 dans tous les cas :
c'est un rapport, la décision reste humaine.
"""
import collections, json, sys

def load(p):
    return {r['key']: r for r in map(json.loads, open(p, encoding='utf-8'))}

def norm(s): return (s or '').upper().replace(' ', '').replace('-', '').replace('<', '')

def verdict(r, t):
    mrz_ok = r.get('lines') == t['lines']
    num_ok = norm(r.get('num')) == norm(t['num'])
    dob_ok = (r.get('dob') or '') == t['birth_iso']
    exp_ok = (r.get('exp') or '') == t['exp_iso'] if t['kind'] != 'cni_old' else None
    nm = norm(r.get('name'))
    full_ok = norm(t['nom']) in nm and norm(t['prenom']) in nm
    return mrz_ok and num_ok and dob_ok and (exp_ok is not False) and full_ok

def main(ref_path, new_path, truth_path='truth.json'):
    T = {r['file']: r for r in json.load(open(truth_path, encoding='utf-8'))}
    A, B = load(ref_path), load(new_path)
    keys = sorted(set(A) & set(B))
    only = sorted(set(A) ^ set(B))
    same_lines = sum(A[k].get('lines') == B[k].get('lines') for k in keys)
    agg = collections.defaultdict(lambda: [0, 0, 0])
    changes = []
    for k in keys:
        t = T[k.split('|')[0]]
        va, vb = verdict(A[k], t), verdict(B[k], t)
        g = f"{A[k]['kind']}/{A[k]['route']}"
        agg[g][0] += 1; agg[g][1] += va; agg[g][2] += vb
        if va != vb:
            changes.append(f"  {'gagné' if vb else 'perdu'} : {k}")
    print(f"appels comparés : {len(keys)}  (absents d'un côté : {len(only)})")
    print(f"lignes MRZ brutes identiques : {same_lines}/{len(keys)}")
    print("\n== Score TOUT par document (référence -> mesure) ==")
    for g, (n, a, b) in sorted(agg.items()):
        pa, pb = 100 * a / n, 100 * b / n
        print(f"{g:22s} n={n:3d} {pa:5.0f}% -> {pb:5.0f}%  écart {pb - pa:+.0f} pt")
    print(f"\n== Verdicts changés : {len(changes)} ==")
    print('\n'.join(changes) if changes else '  aucun')

if __name__ == '__main__':
    main(*sys.argv[1:])
