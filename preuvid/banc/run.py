import json, subprocess, sys, time, os
truth=json.load(open('truth.json')); out=open('results.jsonl','a')
done={json.loads(l)['key'] for l in open('results.jsonl')} if os.path.getsize('results.jsonl') else set()
def call(route,f):
    t=time.time()
    r=subprocess.run(['curl','-s','--noproxy','*','--max-time','90','-F',f'file=@{f}','-F','issuing_country=FR',f'http://127.0.0.1:3002/extract/{route}'],capture_output=True,text=True)
    try: d=json.loads(r.stdout)
    except Exception: d={'success':False,'error':'no-json','raw':r.stdout[:200]}
    return d, round(time.time()-t,2)
for r in truth:
    routes=['front'] if r['kind']!='cni2021' else ['back','front']
    for route in routes:
        key=f"{r['file']}|{route}"
        if key in done: continue
        d,dt=call(route,r['file'])
        res=d.get('result') or {}
        if route=='front':
            o=res.get('ocr') or {}
            rec=dict(lines=res.get('mrz_from_front'),name=o.get('full_name') or o.get('name'),dob=o.get('date_of_birth'),exp=o.get('expiry_date') or o.get('expiration_date'),num=o.get('id_number') or o.get('document_number'),conf=res.get('ocr_confidence'))
        else:
            m=res.get('mrz_result') or {}; q=res.get('qr_payload') or {}; f=m.get('fields') or {}
            rec=dict(lines=m.get('raw_lines'),valid=m.get('check_digits_valid'),name=q.get('full_name') or f.get('full_name'),dob=q.get('date_of_birth'),exp=q.get('expiry_date'),num=q.get('id_number'))
        rec.update(key=key,kind=r['kind'],cond=r['cond'],route=route,ok=bool(d.get('success')),err=d.get('error'),t=dt)
        out.write(json.dumps(rec,ensure_ascii=False)+'\n'); out.flush()
print('DONE')
