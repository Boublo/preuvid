# Paiement à l'usage (lot 4)

Modèle : crédit prépayé, comme les API d'IA. Pas d'abonnement, pas de minimum.

- **Registre** : table en ajout seul. Chaque brique consommée (lecture de pièce, présence, comparaison de visage,
  estimation d'âge) écrit une ligne : application, clé, session, brique, prix unitaire, horodatage.
  Le solde est la somme du registre. C'est la source de vérité, pas le prestataire de paiement.
- **Recharges** : Mollie d'abord (reprendre le code du satellite de paiement), Stripe possible plus tard.
- **Recharge automatique** sous un seuil choisi par le client ; **alertes** à 20 % et 5 % du solde.
- **Plafond mensuel** réglable ; **découvert toléré** court pour ne pas couper une vérification en cours.
- **Prix publics par brique**, paliers de volume. Les montants sont à fixer par David après mesure du coût
  machine (lot 1). Hypothèse de travail non validée : 0,25 € la vérification, 50 offertes par mois.
- **Tableau de consommation** par application et par clé, export CSV, factures mensuelles.
- Une session abandonnée avant toute lecture n'est pas facturée.

Repères de marché : Didit facture environ 0,33 $ le KYC complet ; la vérification d'âge est proche de la
gratuité chez plusieurs acteurs. Positionnement : KYC payant pour les plateformes françaises, âge en produit d'appel.
