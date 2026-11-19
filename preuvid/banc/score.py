import json, collections
T={r['file']:r for r in json.load(open('truth.json'))}
R=[json.loads(l) for l in open('results.jsonl')]
def norm(s): return (s or '').upper().replace(' ','').replace('-','').replace('<','')
agg=collections.defaultdict(lambda: collections.Counter())
SURE=0.95  # seuil « sûr » du moteur (engine/src/services/mrzMerge.ts)
WANT={'document_number':'num','last_name':'nom','first_names':'prenom','date_of_birth':'birth_iso','expiry_date':'exp_iso',
      # Champs de premier niveau (ocr.* de /front), tels que l'API les rend.
      'first_name':'prenom','expiration_date':'exp_iso'}
faux_surs=[]
for r in R:
    t=T[r['key'].split('|')[0]]
    # Série d'extension (lot 1) notée à part : le tableau par document reste comparable au lot 0.
    ext=t.get('serie')=='extension'
    g=(r['kind'],r['route'])+(('extension',) if ext else ()); c=('ext:' if ext else '')
    c=(r['kind'],r['route'],c+r['cond'])
    for src in ('fields','top'):
     for k,(v,conf) in (r.get(src) or {}).items():
        if k in WANT and v and conf is not None and conf>=SURE and t.get(WANT[k]) is not None:
            got=v if k.endswith('date') or k=='date_of_birth' else norm(v)
            want=t[WANT[k]] if k.endswith('date') or k=='date_of_birth' else norm(t[WANT[k]])
            if got!=want: faux_surs.append(f"  {r['key']} {src}.{k}: {v} ({conf}) ≠ {t[WANT[k]]}")
    mrz_ok = r.get('lines')==t['lines']
    num_ok = norm(r.get('num'))==norm(t['num'])
    dob_ok = (r.get('dob') or '')==t['birth_iso']
    exp_ok = (r.get('exp') or '')==t['exp_iso'] if t['kind']!='cni_old' else None
    nm=norm(r.get('name')); nom_ok = norm(t['nom']) in nm; full_ok = nom_ok and norm(t['prenom']) in nm
    allok = mrz_ok and num_ok and dob_ok and (exp_ok is not False) and full_ok
    for k in (g,c):
        a=agg[k]; a['n']+=1; a['mrz']+=mrz_ok; a['num']+=num_ok; a['dob']+=dob_ok; a['nom']+=nom_ok; a['full']+=full_ok; a['all']+=allok; a['crash']+=(not r['ok']); a['t']+=r['t']
        if exp_ok is not None: a['exp']+=exp_ok; a['expn']+=1
def row(k,a):
    n=a['n']; p=lambda x:f"{100*a[x]/n:5.0f}%"
    e=f"{100*a['exp']/a['expn']:5.0f}%" if a['expn'] else '   — '
    return f"{' / '.join(k):42s} n={n:3d} MRZ{p('mrz')} num{p('num')} naiss{p('dob')} exp{e} nom{p('nom')} nom+prénoms{p('full')} TOUT{p('all')} err={a['crash']} {a['t']/n:.1f}s"
print("== Par document =="); 
for k in sorted(k for k in agg if len(k)==2): print(row(k,agg[k]))
print("\n== Par condition ==")
for k in sorted(k for k in agg if len(k)==3): print(row(k,agg[k]))
print("\ntotal appels:",len(R))
print(f"\n== Champs faux présentés comme sûrs (confiance ≥ {SURE}) : {len(faux_surs)} ==")
for l in faux_surs: print(l)
