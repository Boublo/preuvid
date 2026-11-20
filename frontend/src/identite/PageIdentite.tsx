/**
 * Page Preuvid du parcours identité (maquettes 03 à 07), ouverte par le lien d'une session v1 :
 * `/verifier#<jeton>`. Choix de la pièce, photos (prise automatique), lecture, visage, résultat.
 *
 * Le jeton n'est jamais dans la partie de l'adresse envoyée au serveur ; la page le retire aussitôt de
 * la barre d'adresse et le garde pour l'onglet. L'état vient du serveur (POST /v1/parcours/etat) :
 * un rechargement, ou un autre appareil, reprend là où en est la vérification.
 *
 * Sur ordinateur, un QR code propose de continuer sur le téléphone (meilleure caméra arrière) ; cet
 * onglet suit alors l'avancement et affiche le résultat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import * as api from './api';
import { Capture, type EtatCamera } from './Capture';
import { adresseRetour, duree, ecranDe, lienTelephone, lireJeton, numeroEtape, PIECES, termine, titrePhoto, type Ecran, type Piece } from './ecrans';
import { Rosace } from '../age/Rosace';
import { Visage } from '../age/Visage';
import type { LivenessMetadata } from '../hooks/useActiveLiveness';

const surOrdinateur = () => typeof matchMedia === 'function' && !matchMedia('(pointer: coarse)').matches;
const attendre = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const onglet = () => { try { return sessionStorage; } catch { return null; } };

function texteErreur(err: unknown): string {
  if (err instanceof api.ErreurParcours) return err.message;
  return 'La connexion a été interrompue. Réessayez.';
}

function Entete({ indice, etape, machine = false }: { indice: string; etape: 0 | 1 | 2; machine?: boolean }) {
  return (
    <>
      <header className="entete">
        <span className="marque">Preuvid<span aria-hidden="true">.</span></span>
        <span className={`indice${machine ? ' machine' : ''}`}>{indice}</span>
      </header>
      <div className="progression" aria-hidden="true">
        <span className="fait" />
        <span className={etape === 1 ? '' : 'fait'} />
      </div>
    </>
  );
}

const indiceEtape = (e: 0 | 1 | 2) => (e ? `Étape ${e} sur 2` : '');

export function PageIdentite() {
  const [jeton] = useState(() => lireJeton(window.location.hash, onglet()));
  const [etat, setEtat] = useState<api.Etat | null>(null);
  const [introuvable, setIntrouvable] = useState(!jeton);
  const [piece, setPiece] = useState<Piece>(PIECES[0]);
  const [choisi, setChoisi] = useState(false);
  const [ici, setIci] = useState(() => !surOrdinateur());
  const [envoi, setEnvoi] = useState<null | 'recto' | 'verso' | 'visage'>(null);
  const [retenue, setRetenue] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [camera, setCamera] = useState<EtatCamera>('eteinte');
  const [flux, setFlux] = useState<MediaStream | null>(null);
  const [essaiVisage, setEssaiVisage] = useState(0);
  const [effacement, setEffacement] = useState<'non' | 'encours' | 'echec'>('non');
  const fluxCourant = useRef<MediaStream | null>(null);
  const titre = useRef<HTMLHeadingElement>(null);
  const zoneMessage = useRef<HTMLParagraphElement>(null);

  // ── État serveur ────────────────────────────────────────────────────────────────────────────
  const lire = useCallback(async (): Promise<api.Etat | null> => {
    if (!jeton) return null;
    try {
      const e = await api.lireEtat(jeton);
      setEtat(e);
      return e;
    } catch (err) {
      if (err instanceof api.ErreurParcours && err.status === 404) { setIntrouvable(true); return null; }
      throw err;
    }
  }, [jeton]);

  /** Relit l'état jusqu'à ce que le serveur ait fini de travailler (lecture, comparaison du visage). */
  const suivre = useCallback(async (limiteMs = 3 * 60 * 1000): Promise<api.Etat | null> => {
    for (let ecoule = 0; ; ecoule += 1500) {
      // Une lecture d'état ratée (réseau, limite de débit) ne tranche rien : on attend et on relit.
      let e: api.Etat | null | undefined;
      try { e = await lire(); } catch { e = undefined; }
      if (e !== undefined && (!e || ecranDe(e) !== 'lecture')) return e;
      if (ecoule >= limiteMs) return e ?? null;
      await attendre(1500);
    }
  }, [lire]);

  useEffect(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    lire().catch(err => setErreur(texteErreur(err)));
  }, [lire]);

  const serveur: Ecran | null = introuvable ? 'introuvable' : etat ? ecranDe(etat) : null;
  let ecran: Ecran | 'chargement' | 'telephone' = serveur ?? 'chargement';
  if (envoi === 'recto' || envoi === 'verso' || retenue) ecran = 'lecture';
  else if (serveur === 'choix' && choisi) ecran = 'photo';
  if (!ici && serveur && !termine(serveur)) ecran = 'telephone';
  const cote: 'recto' | 'verso' = envoi === 'verso' || serveur === 'photo' ? 'verso' : 'recto';
  const site = etat?.site ?? null;
  const leSite = site ?? 'le site';
  const auSite = site ? `à ${site}` : 'au site';

  // Le serveur travaille, ou l'autre appareil avance : on relit l'état toutes les 2 secondes.
  const attenteServeur = !envoi && (ecran === 'telephone' || (ecran === 'lecture' && !retenue));
  useEffect(() => {
    if (!attenteServeur) return;
    const minuterie = setInterval(() => { lire().catch(() => {}); }, 2000);
    return () => clearInterval(minuterie);
  }, [attenteServeur, lire]);

  // À chaque écran, le focus va au titre (lu par les lecteurs d'écran), ou au message d'erreur s'il y en a
  // un : après une photo illisible, c'est lui qu'il faut entendre d'abord. L'onglet porte le titre de l'écran.
  useEffect(() => {
    const m = zoneMessage.current;
    (m && !m.hidden ? m : titre.current)?.focus();
    const t = titre.current?.textContent?.trim();
    if (t) document.title = `${t} · Preuvid`;
  }, [ecran, cote]);

  // ── Caméra arrière, pour la pièce ──────────────────────────────────────────────────────────
  const couper = useCallback(() => {
    fluxCourant.current?.getTracks().forEach(t => t.stop());
    fluxCourant.current = null;
    setFlux(null);
    setCamera('eteinte');
  }, []);
  useEffect(() => couper, [couper]);
  useEffect(() => { if (ecran !== 'photo' && ecran !== 'lecture') couper(); }, [ecran, couper]);

  // Appelé directement dans le clic (Safari sur iPhone refuse la caméra sinon).
  const allumer = () => {
    if (fluxCourant.current) return;
    if (!navigator.mediaDevices?.getUserMedia) { setCamera('absente'); return; }
    setCamera('demarrage');
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    }).then(
      (s) => { fluxCourant.current = s; setFlux(s); setCamera('prete'); },
      (err: { name?: string }) => setCamera(err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError' ? 'absente'
        : err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'refusee' : 'panne'),
    );
  };

  // ── Envois ─────────────────────────────────────────────────────────────────────────────────
  const envoyerPhoto = useCallback(async (photo: Blob) => {
    if (!etat || !jeton) return;
    const c = cote;
    setEnvoi(c); setErreur(null);
    try {
      await api.envoyerPiece(etat.session, jeton, photo, piece.type, c);
      const e = await suivre();
      const suite = e ? ecranDe(e) : null;
      if (suite === (c === 'recto' ? 'choix' : 'photo')) {
        const dernier = e?.essais_restants === 1 ? ' Dernier essai : si cette photo ne peut pas être lue non plus, la vérification s’arrêtera.' : '';
        setErreur(`La pièce n’a pas pu être lue. Reprenez la photo : à plat, en entier, sans reflet.${dernier}`);
      } else if (suite === 'visage' && e?.lecture) {
        // Laisse voir ce qui a été vérifié avant de passer au visage.
        setRetenue(true);
        setTimeout(() => setRetenue(false), 2200);
      }
    } catch (err) {
      setErreur(texteErreur(err));
      await lire().catch(() => null);
    } finally {
      setEnvoi(null);
    }
  }, [etat, jeton, cote, piece.type, suivre, lire]);

  const envoyerVisage = async (photo: Blob, meta: LivenessMetadata) => {
    if (!etat || !jeton) return;
    setEnvoi('visage'); setErreur(null);
    try {
      await api.envoyerVisage(etat.session, jeton, photo, meta);
      const e = await suivre();
      if (e && ecranDe(e) === 'visage') setErreur('Le visage n’a pas pu être vérifié. Recommencez, face à la lumière.');
    } catch (err) {
      setErreur(texteErreur(err));
    } finally {
      setEnvoi(null);
    }
  };

  const effacer = async () => {
    if (!jeton) return;
    setEffacement('encours');
    try {
      await api.effacerPhotos(jeton);
      await lire();
      setEffacement('non');
    } catch {
      setEffacement('echec');
    }
  };

  const zoneErreur = <p ref={zoneMessage} role="alert" className="message" tabIndex={-1} hidden={!erreur}>{erreur}</p>;
  const etapeAffichee = numeroEtape(ecran === 'chargement' || ecran === 'telephone' ? 'choix' : ecran);
  const retour = adresseRetour(etat?.retour ?? null);

  const piedPhotos = etat && (etat.statut === 'validee' || etat.statut === 'refusee') && (
    etat.photos === 'effacees'
      ? <p className="note" role="status">Vos photos sont supprimées.</p>
      : (
        <>
          {/* Bouton sur sa propre ligne, pas dans la phrase : cible tactile de 44 px (ROADMAP, lot 3). */}
          <p className="note">Photos supprimées après [DÉLAI].</p>
          <button className="lien effacer" onClick={() => void effacer()} disabled={effacement === 'encours'}>
            {effacement === 'encours' ? 'Suppression…' : 'Demander la suppression maintenant'}
          </button>
          {effacement === 'echec' && <p className="note" role="alert">La suppression n’a pas abouti : réessayez dans un instant.</p>}
        </>
      )
  );

  // ── Écrans sombres : photo de la pièce (04) et visage (06) ─────────────────────────────────
  if (ecran === 'photo') {
    return (
      <main className="page sombre">
        <Rosace className="fond-rosace" />
        <Entete indice={indiceEtape(1)} etape={1} />
        <h1 ref={titre} tabIndex={-1}>{titrePhoto(cote, piece)}</h1>
        <p className="chapeau">{etat?.photo_ratee
          ? 'Posez la pièce à plat, ses bords le long des pointillés, puis prenez la photo.'
          : 'La photo part toute seule dès que la pièce est nette dans le cadre.'}</p>
        {zoneErreur}
        <Capture flux={flux} camera={camera} allumer={allumer} envoyer={p => void envoyerPhoto(p)} occupe={!!envoi}
          auto={!etat?.photo_ratee}
          note={cote === 'recto' && piece.verso ? 'Ensuite, on vous demandera le verso.' : undefined} />
        {cote === 'recto' && <button className="lien" onClick={() => setChoisi(false)}>Changer de pièce</button>}
      </main>
    );
  }

  if (ecran === 'visage') {
    return (
      <main className="page sombre">
        <Rosace className="fond-rosace" />
        <Entete indice={indiceEtape(2)} etape={2} />
        <h1 ref={titre} tabIndex={-1}>Maintenant, votre visage</h1>
        <p className="chapeau">Regardez l’écran, puis tournez doucement la tête.</p>
        <Visage key={essaiVisage} envoyer={(p, m) => void envoyerVisage(p, m)} occupe={envoi === 'visage'}
          echec={erreur} relancer={() => { setErreur(null); setEssaiVisage(n => n + 1); }}
          note={`Cette étape vérifie que vous êtes bien là, et que la pièce est la vôtre. Votre visage n’est jamais montré ${auSite}.`} />
      </main>
    );
  }

  const lecture = etat?.lecture ?? null;

  return (
    <main className="page">
      <Rosace className="fond-rosace" />

      {ecran === 'chargement' && (
        <>
          <Entete indice="" etape={1} />
          <h1 ref={titre} tabIndex={-1} className="pouls">Chargement…</h1>
          {zoneErreur}
        </>
      )}

      {ecran === 'telephone' && (
        <>
          <Entete indice="Environ 2 minutes" etape={etapeAffichee} />
          <h1 ref={titre} tabIndex={-1}>Continuez sur votre téléphone</h1>
          <p className="chapeau">Scannez ce code avec l’appareil photo du téléphone : la photo de la pièce y sera plus nette. Cet onglet suit l’avancement.</p>
          <div className="qr" role="img" aria-label="Code à scanner avec le téléphone">
            {jeton ? <QRCode value={lienTelephone(window.location.origin, jeton)} size={200} bgColor="#FBFBF8" fgColor="#0F1F1A" /> : <span className="qr-vide" />}
          </div>
          <p className="note centre" role="status">
            {etat?.statut === 'en_cours' ? 'Le téléphone a pris le relais : suivez les étapes dessus.' : 'Le code ne contient que le lien de cette vérification, rien sur vous.'}
          </p>
          <div className="bas">
            <button className="lien" onClick={() => setIci(true)}>Continuer sur cet ordinateur</button>
          </div>
        </>
      )}

      {ecran === 'choix' && (
        <>
          <Entete indice={indiceEtape(1)} etape={1} />
          <h1 ref={titre} tabIndex={-1}>Quelle pièce avez-vous sous la main ?</h1>
          <p className="chapeau">Environ 2 minutes. Prenez l’original, pas une photocopie ni un écran.</p>
          {zoneErreur}
          <fieldset className="choix">
            <legend>Type de pièce</legend>
            {PIECES.map(p => (
              <label key={p.cle} className="option">
                <input type="radio" name="piece" value={p.cle} checked={piece.cle === p.cle} onChange={() => setPiece(p)} />
                <strong>{p.titre}</strong>
                <small>{p.detail}</small>
              </label>
            ))}
          </fieldset>
          <div className="bas">
            <button className="bouton" onClick={() => { setErreur(null); allumer(); setChoisi(true); }}>Prendre la photo</button>
            <p className="note">{site ? `${site} recevra` : 'Le site recevra'} le résultat et ce qui est écrit sur la pièce, jamais vos photos. Elles sont chiffrées, puis supprimées après [DÉLAI].</p>
          </div>
        </>
      )}

      {ecran === 'lecture' && (
        <>
          <Entete indice={indiceEtape(1)} etape={1} />
          <h1 ref={titre} tabIndex={-1}>{piece.type === 'passport' ? 'On lit votre passeport' : 'On lit votre carte'}</h1>
          <p className="chapeau" role="status">Quelques secondes. Gardez cette page ouverte.</p>
          <dl className="registre lecture" aria-live="polite">
            <div><dt>Photo reçue</dt><dd>{envoi ? 'envoi…' : 'faite'}</dd></div>
            <div><dt>Bande du bas lue</dt><dd>{lecture?.mrz ? 'faite' : '…'}</dd></div>
            <div><dt>Clés de contrôle</dt><dd>{lecture?.cles ? `${lecture.cles.justes} sur ${lecture.cles.total}` : '…'}</dd></div>
            <div><dt>Date de validité</dt><dd>{lecture?.validite === 'valide' ? 'en cours' : lecture?.validite === 'depassee' ? 'dépassée' : '…'}</dd></div>
          </dl>
          {zoneErreur}
          <div className="bas"><p className="note">Vos photos sont chiffrées dès leur arrivée.</p></div>
        </>
      )}

      {ecran === 'validee' && etat && (
        <>
          <Entete indice={duree(etat.duree_s)} etape={0} machine />
          <span className="tampon-resultat violet" aria-hidden="true">vérifié</span>
          <h1 ref={titre} tabIndex={-1}>C’est fait.</h1>
          <p className="chapeau">{retour ? `Vous pouvez retourner sur ${leSite}.` : 'Vous pouvez fermer cette page.'} Rien d’autre à faire.</p>
          <p className="legende">Ce que {leSite} reçoit</p>
          <dl className="registre recu">
            <div><dt>Identité confirmée</dt><dd>oui</dd></div>
            <div><dt>Nom, prénoms, date de naissance</dt><dd>oui</dd></div>
            <div><dt>Numéro et validité de la pièce, nationalité, sexe</dt><dd>oui</dd></div>
            <div><dt>Vos photos</dt><dd className="non">non</dd></div>
          </dl>
          <div className="bas">
            {retour && <a className="bouton" href={retour} rel="noreferrer">Retourner sur {leSite}</a>}
            {piedPhotos}
          </div>
        </>
      )}

      {ecran === 'refusee' && etat && (
        <>
          <Entete indice="" etape={0} />
          <h1 ref={titre} tabIndex={-1}>La vérification n’a pas abouti</h1>
          <p className="chapeau">{etat.motif ? `Motif : ${etat.motif}.` : 'La pièce ou le visage n’ont pas pu être vérifiés.'} {leSite === 'le site' ? 'Le site a' : `${leSite} a`} reçu ce résultat. Pour réessayer, repassez par {leSite} : un nouveau lien vous sera donné.</p>
          <div className="bas">
            {retour && <a className="bouton" href={retour} rel="noreferrer">Retourner sur {leSite}</a>}
            {piedPhotos}
          </div>
        </>
      )}

      {ecran === 'a_revoir' && (
        <>
          <Entete indice="" etape={0} />
          <h1 ref={titre} tabIndex={-1}>Une personne va vérifier votre pièce</h1>
          <p className="chapeau">Tout a été reçu. Le résultat sera envoyé {auSite} dès qu’elle l’aura fait. Vous pouvez fermer cette page.</p>
          <div className="bas">
            {retour && <a className="bouton" href={retour} rel="noreferrer">Retourner sur {leSite}</a>}
            <p className="note">Vos photos restent chiffrées jusqu’à cette vérification, puis sont supprimées après [DÉLAI].</p>
          </div>
        </>
      )}

      {ecran === 'expiree' && (
        <>
          <Entete indice="" etape={0} />
          <h1 ref={titre} tabIndex={-1}>Ce lien a expiré</h1>
          <p className="chapeau">Repassez par {leSite} : il vous donnera un nouveau lien.</p>
          {retour && <div className="bas"><a className="bouton" href={retour} rel="noreferrer">Retourner sur {leSite}</a></div>}
        </>
      )}

      {ecran === 'introuvable' && (
        <>
          <Entete indice="" etape={0} />
          <h1 ref={titre} tabIndex={-1}>Lien inconnu</h1>
          <p className="chapeau">Ce lien n’existe pas, ou la vérification a été supprimée. Repassez par le site qui vous l’a donné.</p>
        </>
      )}
    </main>
  );
}
