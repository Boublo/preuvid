import json, collections
T={r['file']:r for r in json.load(open('truth.json'))}
R=[json.loads(l) for l in open('results.jsonl')]
def norm(s): return (s or '').upper().replace(' ','').replace('-','').replace('<','')
agg=collections.defaultdict(lambda: collections.Counter())
for r in R:
    t=T[r['key'].split('|')[0]]; g=(r['kind'],r['route']); c=(r['kind'],r['route'],r['cond'])
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
