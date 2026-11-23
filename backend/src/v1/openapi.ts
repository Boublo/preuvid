/**
 * Description OpenAPI 3.1 de l'API v1, servie sur GET /v1/openapi.json.
 * Un test vérifie que chaque route montée sur le routeur v1 y figure, et inversement.
 * Les valeurs d'énumération viennent du code (statuts, événements) pour ne pas diverger.
 */

import { V1_STATUTS } from './decision.js';
import { V1_EVENEMENTS, REPRISES_MINUTES } from './webhooks.js';

const ref = (nom: string) => ({ $ref: `#/components/schemas/${nom}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const erreur = (description: string) => ({ description, content: json(ref('Erreur')) });
const idSession = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

export const openapiV1 = {
  openapi: '3.1.0',
  info: {
    title: 'API Preuvid',
    version: '1.0.0',
    description:
      'Vérification d’identité et d’âge. Une session par personne : vous la créez, la personne suit '
      + 'le lien, vous recevez un webhook signé puis lisez la décision. Les clés de test (sandbox) '
      + 'ne voient que les sessions de test.',
  },
  servers: [{ url: '/v1' }],
  security: [{ cleApi: [] }],
  paths: {
    '/sessions': {
      post: {
        summary: 'Créer une session',
        parameters: [{
          name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 },
          description: 'Rejouer la même requête avec la même clé (24 h) renvoie la même session.',
        }],
        requestBody: { required: true, content: json(ref('CreationSession')) },
        responses: {
          201: { description: 'Session créée', content: json(ref('SessionCreee')) },
          400: erreur('Corps invalide'),
          401: erreur('Clé d’API absente ou invalide'),
          409: erreur('Même Idempotency-Key, requête encore en cours'),
          422: erreur('Même Idempotency-Key, corps différent'),
          429: erreur('Limite de débit dépassée (300 écritures par minute et par clé)'),
        },
      },
    },
    '/sessions/{id}': {
      get: {
        summary: 'État d’une session',
        parameters: [idSession],
        responses: { 200: { description: 'Session', content: json(ref('Session')) }, 404: erreur('Session introuvable') },
      },
      delete: {
        summary: 'Supprimer une session et ses photos',
        parameters: [idSession],
        responses: {
          204: { description: 'Supprimée. Un événement session.supprimee est émis.' },
          404: erreur('Session introuvable'),
          503: erreur('Photos non effacées, rien n’a été supprimé : réessayer'),
        },
      },
    },
    '/sessions/{id}/decision': {
      get: {
        summary: 'Décision, motif et champs lus',
        description: 'Parcours `age` : seulement `majeur` (`false` = majorité non prouvée).',
        parameters: [idSession],
        responses: {
          200: { description: 'Décision', content: json({ oneOf: [ref('DecisionIdentite'), ref('DecisionAge')] }) },
          404: erreur('Session introuvable'),
        },
      },
    },
    '/sessions/{id}/evenements': {
      get: {
        summary: 'Événements de webhook d’une session et leurs livraisons',
        parameters: [idSession],
        responses: { 200: { description: 'Événements', content: json(ref('ListeEvenements')) }, 404: erreur('Session introuvable') },
      },
    },
    '/evenements/{id}/rejouer': {
      post: {
        summary: 'Rejouer un événement de webhook',
        description: 'Nouvel envoi immédiat, même X-Preuvid-Event-Id, horodatage neuf.',
        parameters: [{ ...idSession, description: 'Identifiant d’événement' }],
        responses: {
          202: { description: 'Envoi tenté', content: json({ type: 'object', properties: { id: { type: 'string' }, livre: { type: 'boolean' } } }) },
          404: erreur('Événement introuvable'),
        },
      },
    },
    '/openapi.json': {
      get: { summary: 'Cette description', security: [], responses: { 200: { description: 'OpenAPI 3.1' } } },
    },
    '/age/cles': {
      get: {
        summary: 'Clés publiques du passe majeur',
        description: 'Une clé signifie « majeur » pendant sa période de validité. À récupérer côté serveur, au plus '
          + 'une fois par heure. Variante RSABSSA-SHA384-PSS-Randomized (RFC 9474) : la preuve est une signature '
          + 'RSA-PSS SHA-384 (sel de 48 octets) d’un message de 64 octets, aléa de 32 octets suivi de votre défi.',
        security: [],
        responses: { 200: { description: 'Clés', content: json(ref('ClesAge')) } },
      },
    },
    '/age/releves': {
      post: {
        summary: 'Déclarer les preuves d’âge acceptées (comptage différé)',
        description: 'Au moins une fois par jour, jusqu’à 1 000 preuves par appel. Chaque preuve est vérifiée ; '
          + 'une preuve déjà déclarée compte comme doublon.',
        requestBody: { required: true, content: json(ref('Releve')) },
        responses: {
          200: { description: 'Bilan', content: json(ref('BilanReleve')) },
          400: erreur('Corps invalide'),
          401: erreur('Clé d’API absente ou invalide'),
        },
      },
    },
  },
  webhooks: {
    evenementSession: {
      post: {
        summary: 'Événement de session',
        description:
          'En-têtes : X-Preuvid-Signature = HMAC-SHA256 hexadécimal de `horodatage.corps` avec le secret '
          + 'du webhook ; X-Preuvid-Timestamp (secondes Unix, refuser au-delà de cinq minutes) ; '
          + 'X-Preuvid-Event-Id (identique à chaque reprise, pour dédoublonner). Seule une réponse 2xx '
          + `vaut livraison ; reprises après ${REPRISES_MINUTES.join(', ')} minutes.`,
        requestBody: { content: json(ref('Evenement')) },
        responses: { 200: { description: 'Reçu' } },
      },
    },
  },
  components: {
    securitySchemes: { cleApi: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
    schemas: {
      Statut: { type: 'string', enum: [...V1_STATUTS] },
      Parcours: { type: 'string', enum: ['identite', 'age'] },
      Erreur: {
        type: 'object', required: ['erreur'],
        properties: { erreur: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } },
      },
      CreationSession: {
        type: 'object', required: ['parcours'], additionalProperties: false,
        properties: {
          parcours: ref('Parcours'),
          reference: { type: 'string', maxLength: 255, description: 'Votre identifiant, opaque pour Preuvid. Jamais envoyé dans les webhooks.' },
          retour: { type: 'string', format: 'uri', maxLength: 2000, description: 'URL https où renvoyer la personne à la fin.' },
        },
      },
      SessionCreee: {
        allOf: [ref('Session'), { type: 'object', properties: { lien: { type: 'string', format: 'uri', description: 'À ouvrir par la personne. Valable une heure, affiché une seule fois.' } } }],
      },
      Session: {
        type: 'object',
        properties: {
          session: { type: 'string', format: 'uuid' },
          parcours: ref('Parcours'),
          statut: ref('Statut'),
          reference: { type: ['string', 'null'] },
          retour: { type: ['string', 'null'] },
          expire_le: { type: 'string', format: 'date-time' },
          cree_le: { type: 'string', format: 'date-time' },
          test: { type: 'boolean' },
        },
      },
      Champ: {
        type: 'object',
        properties: {
          valeur: { type: ['string', 'null'] },
          cle: { type: 'string', enum: ['juste', 'corrigee', 'fausse', 'sans_cle', 'absente'], description: 'État de la clé de contrôle MRZ qui couvre le champ.' },
          source: { type: ['string', 'null'], enum: ['mrz', 'zone_imprimee', 'concordants', null] },
        },
      },
      DecisionIdentite: {
        type: 'object',
        properties: {
          session: { type: 'string' }, parcours: { const: 'identite' }, statut: ref('Statut'),
          motif: { type: ['object', 'null'], properties: { code: { type: 'string' }, texte: { type: 'string' } } },
          visage: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
          champs: { type: ['object', 'null'], additionalProperties: ref('Champ') },
        },
      },
      DecisionAge: {
        type: 'object',
        properties: { session: { type: 'string' }, parcours: { const: 'age' }, statut: ref('Statut'), majeur: { type: ['boolean', 'null'] } },
      },
      Evenement: {
        type: 'object',
        properties: {
          evenement: { type: 'string', enum: [...V1_EVENEMENTS] },
          session: { type: 'string', format: 'uuid' },
          parcours: ref('Parcours'),
          statut: { type: 'string' },
          majeur: { type: 'boolean', description: 'Parcours age seulement.' },
          date: { type: 'string', format: 'date-time' },
        },
      },
      ClesAge: {
        type: 'object',
        properties: {
          variante: { const: 'RSABSSA-SHA384-PSS-Randomized' },
          cles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'SHA-256 hexadécimal de la clé publique (SPKI)' },
                spki: { type: 'string', description: 'Clé publique RSA, SPKI DER en base64' },
                valide_du: { type: 'string', format: 'date-time' }, valide_au: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      Releve: {
        type: 'object', required: ['preuves'], additionalProperties: false,
        properties: {
          preuves: {
            type: 'array', minItems: 1, maxItems: 1000,
            items: {
              type: 'object', required: ['cle', 'message', 'signature'], additionalProperties: false,
              properties: {
                cle: { type: 'string', description: 'Identifiant de la clé' },
                message: { type: 'string', description: 'Message signé (64 octets), base64url' },
                signature: { type: 'string', description: 'Signature (256 octets), base64url' },
              },
            },
          },
        },
      },
      BilanReleve: {
        type: 'object',
        properties: { acceptees: { type: 'integer' }, doublons: { type: 'integer' }, invalides: { type: 'integer' } },
      },
      ListeEvenements: {
        type: 'object',
        properties: {
          evenements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, evenement: { type: 'string' }, etat: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
                tentatives: { type: 'integer' }, prochaine_tentative: { type: ['string', 'null'] },
                derniere_reponse: { type: ['integer', 'null'] }, livre_le: { type: ['string', 'null'] }, cree_le: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;
