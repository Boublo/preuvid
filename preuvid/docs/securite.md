# Sécurité et données personnelles

Les photos de pièces et de visages sont des données sensibles (biométrie au sens du RGPD). Règles non négociables :

1. **Minimiser** : ne garder que ce qui sert à la décision et au litige. Pour l'âge : aucune image après la réponse.
2. **Chiffrer** : photos chiffrées au repos (AES-256-GCM par enveloppe), TLS partout, clé maîtresse hors de la base.
3. **Supprimer** : suppression automatique après `[DÉLAI]` (30 jours proposés), suppression immédiate à la demande,
   tâche de purge testée.
4. **Cloisonner** : moteur et base non exposés ; ports 80/443 seuls ; un compte de base par service, droits minimaux.
5. **Tracer** : journal d'audit en ajout seul pour toute ouverture de fiche, affichage de photo, décision, changement de seuil.
6. **Ne rien journaliser de personnel** : ni nom, ni numéro de pièce, ni image, ni MRZ dans les logs et les erreurs.
7. **Authentifier** : double authentification obligatoire en administration ; clés d'API hachées, affichées une fois,
   révocables, séparées test / production ; limites de débit par clé.
8. **Webhooks** : signature HMAC-SHA256 sur horodatage + corps, fenêtre de cinq minutes, identifiant d'événement
   pour dédoublonner.
9. **Chaîne logicielle** : pas de mise à jour automatique en production, modèles figés avec somme de contrôle,
   dépendances épinglées, aucune récupération de code ou de modèle à l'exécution.
10. **Secrets** : jamais dans le dépôt ; `.env` hors Git ; rotation documentée.
11. **Fichiers reçus** : type vérifié par octets magiques, taille bornée, image réencodée avant traitement.
12. **Sauvegardes** : chiffrées, restauration testée, même durée de vie que les données.
13. **Mesures d'usage** : abandons et durées par étape comptés une fois par session dans `v1_mesures`
    (`backend/src/v1/mesures.ts`) : jour, parcours, issue, nombre de photos par côté, durées arrondies à 5 s.
    Ni identifiant de session, ni site, ni heure, ni adresse IP, ni navigateur. Relevé réservé aux
    administrateurs de la plateforme (`GET /api/admin/preuvid/mesures`).

À produire avant l'ouverture (lot 5) : registre des traitements, analyse d'impact, contrat de sous-traitance, test d'intrusion.
Certifications (iBeta, ISO 27001, SOC 2) : aucune la première année ; ne pas s'en prévaloir.
