"""Synthetic French ID generator for the MRZ/OCR bench. Fictional identities only."""
import random, json, sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, cv2

MONO="/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANSB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
NOMS=["MARTIN","BERNARD","DUBOIS","LEFEBVRE","MOREAU","GARCIA","ROUSSEAU","FOURNIER","LE GALL","DE LA FONTAINE"]
PRENOMS=["CAMILLE","LUCAS","EMMA","HUGO","LEA","JEAN PIERRE","MARIE CLAIRE","NOAH","INES","THEO"]

def cd(s):
    w=[7,3,1]; t=0
    for i,c in enumerate(s):
        v=0 if c=='<' else (int(c) if c.isdigit() else ord(c)-55)
        t+=v*w[i%3]
    return str(t%10)
def mz(s): return s.replace(' ','<').replace("'",'<').replace('-','<')

def identity(rng):
    nom=rng.choice(NOMS); pre=rng.choice(PRENOMS); sex=rng.choice("MF")
    by=rng.randint(1950,2005); bm=rng.randint(1,12); bd=rng.randint(1,28)
    ey=rng.randint(2027,2035); em=rng.randint(1,12); ed=rng.randint(1,28)
    return dict(nom=nom,prenom=pre,sex=sex,birth=f"{by%100:02d}{bm:02d}{bd:02d}",birth_iso=f"{by}-{bm:02d}-{bd:02d}",
                exp=f"{ey%100:02d}{em:02d}{ed:02d}",exp_iso=f"{ey}-{em:02d}-{ed:02d}")

def cni2021(idt,rng):
    num=''.join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ0123456789") for _ in range(9))
    l1=("IDFRA"+num+cd(num)).ljust(30,'<')
    l2=idt['birth']+cd(idt['birth'])+idt['sex']+idt['exp']+cd(idt['exp'])+"FRA"+"<"*11
    l2+=cd(l1[5:30]+l2[0:7]+l2[8:15]+l2[18:29])
    l3=(mz(idt['nom'])+"<<"+mz(idt['prenom'])).ljust(30,'<')[:30]
    return num,[l1,l2,l3]
def cni_old(idt,rng):
    yymm=f"{rng.randint(10,20):02d}{rng.randint(1,12):02d}"; dept=f"{rng.randint(1,95):02d}"+str(rng.randint(1,9)); n=f"{rng.randint(0,99999):05d}"
    num=yymm+dept+n
    l1=("IDFRA"+mz(idt['nom'])).ljust(30,'<')[:30]+"<"*6
    l2=num+cd(num)+mz(idt['prenom']).ljust(14,'<')[:14]+idt['birth']+cd(idt['birth'])+idt['sex']
    l2+=cd(l1+l2)
    return num,[l1,l2]
def passport(idt,rng):
    num=f"{rng.randint(10,99)}"+''.join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(2))+f"{rng.randint(0,99999):05d}"
    l1=("P<FRA"+mz(idt['nom'])+"<<"+mz(idt['prenom'])).ljust(44,'<')[:44]
    l2=num+cd(num)+"FRA"+idt['birth']+cd(idt['birth'])+idt['sex']+idt['exp']+cd(idt['exp'])+"<"*14+cd("<"*14)
    l2+=cd(l2[0:10]+l2[13:20]+l2[21:43])
    return num,[l1,l2]

def render(kind,idt,num,lines):
    W,H=(1012,638) if kind!='passport' else (1240,880)
    rng=np.random.default_rng(abs(hash(num))%2**32)
    bg=np.full((H,W,3),(232,238,244),np.uint8)
    yy,xx=np.mgrid[0:H,0:W]
    wave=(8*np.sin(xx/23.0+yy/41.0)+6*np.sin(yy/17.0)).astype(np.int16)
    bg=np.clip(bg.astype(np.int16)+wave[...,None]+np.array([0,4,10]),0,255).astype(np.uint8)
    im=Image.fromarray(bg); d=ImageDraw.Draw(im)
    f=ImageFont.truetype(SANS,20); fb=ImageFont.truetype(SANSB,30); fs=ImageFont.truetype(SANS,16)
    mrzsize={'cni2021':45,'cni_old':38,'passport':38}[kind]
    fm=ImageFont.truetype(MONO,mrzsize)
    d.text((40,24),"RÉPUBLIQUE FRANÇAISE",font=fb,fill=(20,40,110))
    title={'cni2021':"CARTE NATIONALE D'IDENTITÉ / IDENTITY CARD",'cni_old':"CARTE NATIONALE D'IDENTITÉ N° : "+num,'passport':"PASSEPORT / PASSPORT"}[kind]
    d.text((40,66),title,font=f,fill=(20,40,110))
    x0=330 if kind!='cni2021' else 40
    if kind!='cni2021':
        d.rectangle((40,120,290,430),fill=(205,210,216),outline=(120,120,120))  # photo placeholder (no face)
    rows=[("Nom / Surname",idt['nom']),("Prénoms / Given names",idt['prenom']),("Sexe / Sex",idt['sex']),
          ("Date de naissance / Date of birth",'.'.join([idt['birth_iso'][8:],idt['birth_iso'][5:7],idt['birth_iso'][:4]]))]
    if kind!='cni_old': rows.append(("Date d'expiration / Expiry date",'.'.join([idt['exp_iso'][8:],idt['exp_iso'][5:7],idt['exp_iso'][:4]])))
    if kind!='cni_old': rows.append(("N° du document / Document No",num))
    if kind=='cni2021': rows=rows[4:]+[("Adresse / Address","12 RUE DES LILAS 38000 GRENOBLE")]
    y=120
    for lab,val in rows:
        d.text((x0,y),lab,font=fs,fill=(70,70,90)); d.text((x0,y+20),val,font=ImageFont.truetype(SANSB,26),fill=(15,15,20)); y+=62
    my=H-30-len(lines)*(mrzsize+14)
    d.rectangle((0,my-16,W,H),fill=(244,246,248))
    for i,l in enumerate(lines): d.text((36,my+i*(mrzsize+14)),l,font=fm,fill=(10,10,10))
    return im

def degrade(im,cond,seed):
    rng=np.random.default_rng(seed); a=cv2.cvtColor(np.array(im),cv2.COLOR_RGB2BGR); h,w=a.shape[:2]
    def onbg(a,M=None,pad=120):
        H,W=h+2*pad,w+2*pad; canvas=np.full((H,W,3),(60,75,95),np.uint8); canvas[pad:pad+h,pad:pad+w]=a; return canvas
    q=92
    if cond=='propre': pass
    elif cond=='flou': a=cv2.GaussianBlur(a,(0,0),2.2)
    elif cond=='rotation': c=onbg(a); H,W=c.shape[:2]; M=cv2.getRotationMatrix2D((W/2,H/2),7,1); a=cv2.warpAffine(c,M,(W,H),borderValue=(60,75,95))
    elif cond=='perspective':
        c=onbg(a); H,W=c.shape[:2]; p=120
        src=np.float32([[p,p],[p+w,p],[p+w,p+h],[p,p+h]]); dst=np.float32([[p+60,p+30],[p+w-20,p-10],[p+w,p+h+10],[p-10,p+h-40]])
        a=cv2.warpPerspective(c,cv2.getPerspectiveTransform(src,dst),(W,H),borderValue=(60,75,95))
    elif cond=='basse_resolution': a=cv2.resize(a,(520,int(520*h/w)),interpolation=cv2.INTER_AREA)
    elif cond=='jpeg_fort': q=22
    elif cond=='reflet':
        ov=a.copy(); cv2.ellipse(ov,(int(w*0.55),int(h*0.80)),(220,70),-12,0,360,(255,255,255),-1); ov=cv2.GaussianBlur(ov,(0,0),25); a=cv2.addWeighted(a,0.35,ov,0.65,0)
    elif cond=='sombre_bruit':
        a=(a*0.45).astype(np.float32)+rng.normal(0,14,a.shape); a=np.clip(a,0,255).astype(np.uint8)
    return a,q

CONDS=['propre','flou','rotation','perspective','basse_resolution','jpeg_fort','reflet','sombre_bruit']
if __name__=="__main__":
    n=int(sys.argv[1]) if len(sys.argv)>1 else 8
    os.makedirs("img",exist_ok=True)  # cv2.imwrite échoue sans rien dire si le dossier manque
    rng=random.Random(20261118); truth=[]
    for i in range(n):
        idt=identity(rng)
        for kind,fn in (('cni2021',cni2021),('cni_old',cni_old),('passport',passport)):
            num,lines=fn(idt,rng); im=render(kind,idt,num,lines)
            for c in CONDS:
                a,q=degrade(im,c,i*100+CONDS.index(c)); fn_=f"img/{kind}_{i:02d}_{c}.jpg"
                cv2.imwrite(fn_,a,[cv2.IMWRITE_JPEG_QUALITY,q])
                truth.append(dict(file=fn_,kind=kind,cond=c,num=num,lines=lines,**idt))
    json.dump(truth,open("truth.json","w"),indent=1); print(len(truth),"images")
