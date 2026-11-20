/**
 * Passe majeur : la vérification d'âge du passe exige aussi le visage (selfie, détection du vivant par
 * mouvement de tête, comparaison avec la photo de la pièce). Sans cela, un mineur pouvait présenter la
 * pièce d'un parent.
 *
 * Le mode du moteur reste `age_only` : tous les garde-fous de l'âge (seuil, effacement des images,
 * réponse réduite à « majeur ») restent attachés à ce mode. Une marque dans `addons`, posée seulement par
 * `ouvrirVerification`, ajoute l'étape du visage après la lecture de la date de naissance.
 */

import type { FlowConfig } from '@idswyft/shared';

export const MARQUE_VISAGE = 'preuvid_passe_visage';

export function avecVisage(addons: unknown): boolean {
  return !!addons && typeof addons === 'object' && (addons as Record<string, unknown>)[MARQUE_VISAGE] === true;
}

/** Parcours effectif : celui du mode, plus le visage pour une vérification du passe. */
export function fluxAge(flow: FlowConfig, addons: unknown): FlowConfig {
  if (flow.preset !== 'age_only' || !avecVisage(addons)) return flow;
  return {
    ...flow,
    requiresLiveness: true,
    requiresFaceMatch: true,
    totalSteps: 2,
    afterFront: 'AWAITING_LIVE',
    afterCrossVal: 'AWAITING_LIVE',
  } as FlowConfig;
}
