/** Morceaux communs à la page du passe (ordinateur ou téléphone) et à la page photo du téléphone. */

import type { ReactNode } from 'react';
import * as api from './api';

export function texteErreur(err: unknown): string {
  if (err instanceof api.ErreurAge) return err.message;
  const nom = (err as { name?: string })?.name;
  if (nom === 'NotAllowedError') return 'Confirmation annulée ou délai dépassé. Vous pouvez réessayer.';
  if (nom === 'InvalidStateError') return 'Un passe existe déjà sur cet appareil. Utilisez-le.';
  return 'Une erreur est survenue. Réessayez.';
}

export function Entete({ indice, machine = false }: { indice: string; machine?: boolean }) {
  return (
    <header className="entete">
      <span className="marque">Preuvid<span aria-hidden="true">.</span></span>
      <span className={`indice${machine ? ' machine' : ''}`}>{indice}</span>
    </header>
  );
}

const PIECES = [['national_id', 'Carte d’identité'], ['passport', 'Passeport'], ['drivers_license', 'Permis de conduire']] as const;

/**
 * Type de pièce, puis la photo du recto (appareil photo arrière sur téléphone). Le champ fichier est
 * caché à l'œil mais reste atteignable au clavier : c'est son libellé qui fait office de bouton.
 */
export function ChoixPiece({ type, choisir, occupe, envoyer, children }: {
  type: api.TypePiece; choisir: (t: api.TypePiece) => void; occupe: boolean; envoyer: (photo: File) => void; children?: ReactNode;
}) {
  return (
    <>
      <fieldset className="choix">
        <legend>Type de pièce</legend>
        {PIECES.map(([v, t]) => (
          <label key={v} className="option">
            <input type="radio" name="piece" value={v} checked={type === v} onChange={() => choisir(v)} />
            <strong>{t}</strong>
          </label>
        ))}
      </fieldset>
      <div className="bas">
        <p className="note">À plat, en entier, sans reflet.</p>
        <label className={`bouton photo${occupe ? ' occupe' : ''}`}>
          <input className="sr" type="file" accept="image/*" capture="environment" disabled={occupe}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) envoyer(f); }} />
          {occupe ? 'Envoi…' : 'Prendre la photo du recto'}
        </label>
        {children}
      </div>
    </>
  );
}
