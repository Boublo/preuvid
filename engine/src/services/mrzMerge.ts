/**
 * Fusion de la MRZ et de la zone imprimée (lot 1 Preuvid).
 *
 * Règles :
 * - un champ dont la clé de contrôle est fausse n'est jamais repris de la MRZ ;
 * - un champ couvert par une clé juste remplace la lecture de la zone imprimée ;
 * - un champ seulement « corrigé » par les clés, ou sans clé (noms du passeport et de la
 *   CNI 2021), n'est présenté comme sûr que si la zone imprimée dit la même chose ;
 * - en cas de désaccord sur un nom, la zone imprimée l'emporte, avec une confiance basse.
 *
 * « Sûr » veut dire confiance ≥ SURE_CONFIDENCE.
 */

import type { OCRData } from '@/types/index.js';
import type { FieldCheck, MrzReading } from '@/services/mrzReader.js';

export const SURE_CONFIDENCE = 0.95;
const DISAGREEMENT_CONFIDENCE = 0.6;

export interface MergedField {
  value: string | null;
  /** Statut de la clé de contrôle MRZ qui couvre le champ. */
  check: FieldCheck | 'absent';
  /** `mrz`, `zone_imprimee`, ou `concordants` si les deux disent la même chose. */
  source: 'mrz' | 'zone_imprimee' | 'concordants' | null;
  confidence: number;
}

export type MergedFields = Record<
  'document_number' | 'last_name' | 'first_names' | 'date_of_birth' | 'expiry_date' | 'nationality' | 'sex',
  MergedField
>;

/** Majuscules sans accents, séparateurs MRZ et ponctuation ramenés à une espace. */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[<'’\-,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const compact = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Valeur imprimée sous un libellé (« Nom / Surname », ligne suivante). */
function valueAfterLabel(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (label.test(lines[i])) {
      const v = lines[i + 1].trim();
      if (v && !/[\/:]/.test(v)) return v;
    }
  }
  return null;
}

export interface PrintedZone {
  last_name: string | null;
  first_names: string | null;
  document_number: string | null;
  /** Date de naissance imprimée, au format ISO. */
  date_of_birth: string | null;
}

/** Rubrique numérotée du permis de conduire (« 1. LEFEBVRE », « 5. 18AB12345 »). */
function numberedField(lines: string[], n: string): string | null {
  const re = new RegExp(`^\\s*${n}\\.\\s+(.+?)\\s*$`);
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Ligne qui suit la rubrique `n`, quand l'OCR a perdu le numéro de la suivante
 * (sur le banc, « 2. WEI » lu « . WEI »). Lettres seulement.
 */
function lineAfterNumbered(lines: string[], n: string): string | null {
  const re = new RegExp(`^\\s*${n}\\.\\s+`);
  const i = lines.findIndex(l => re.test(l));
  const m = i >= 0 ? lines[i + 1]?.match(/^\s*[.,]?\s*([A-ZÀ-Ü][A-ZÀ-Ü' -]*?)\s*$/) : null;
  return m ? m[1] : null;
}

function isoFromPrinted(v: string | null): string | null {
  const m = v?.match(/(\d{2})[./ ](\d{2})[./ ](\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** Lit les libellés bilingues des titres français, ou les rubriques numérotées du permis. */
export function readPrintedZone(rawText: string): PrintedZone {
  const lines = (rawText ?? '').split('\n');
  const inlineNumber = lines
    .map(l => l.match(/N[°º]\s*:?\s*([A-Z0-9]{9,12})\s*$/i)?.[1] ?? null)
    .find(Boolean) ?? null;
  const permitNumber = numberedField(lines, '5')?.match(/^([A-Z0-9]{9,12})\b/)?.[1] ?? null;
  return {
    last_name: valueAfterLabel(lines, /^\s*Nom\b.*Surname/i) ?? numberedField(lines, '1'),
    first_names: valueAfterLabel(lines, /^\s*Pr[ée]noms?\b.*Given/i) ?? numberedField(lines, '2')
      ?? lineAfterNumbered(lines, '1'),
    document_number: valueAfterLabel(lines, /N[°º]\s*du\s*document|Document\s*No/i) ?? inlineNumber ?? permitNumber,
    date_of_birth: isoFromPrinted(valueAfterLabel(lines, /Date\s*de\s*naissance|Date\s*of\s*birth/i))
      ?? isoFromPrinted(numberedField(lines, '3')),
  };
}

/**
 * @param truncatedAt longueur à laquelle la MRZ tronque le nom (8 pour le permis) : une zone
 *   imprimée qui commence pareil concorde, mais la fin du nom n'est vérifiée par rien.
 */
function mergeName(mrz: MrzReading['fields']['last_name'], printed: string | null, truncatedAt?: number): MergedField {
  const m = mrz.value && mrz.check !== 'fausse' ? normalizeName(mrz.value) : null;
  const p = printed ? normalizeName(printed) : null;
  if (m && p) {
    if (m === p) return { value: m, check: mrz.check, source: 'concordants', confidence: 0.99 };
    // Comparaison dans l'alphabet MRZ : « DE LA FONTAINE » s'y écrit « DE<LA<FO » sur 8 caractères.
    const inMrz = (x: string) => x.replace(/ /g, '<').slice(0, truncatedAt);
    if (truncatedAt && p.length > truncatedAt && inMrz(m).length === truncatedAt && inMrz(p) === inMrz(m)) {
      return { value: p, check: mrz.check, source: 'concordants', confidence: 0.9 };
    }
    return { value: p, check: mrz.check, source: 'zone_imprimee', confidence: DISAGREEMENT_CONFIDENCE };
  }
  if (m) return { value: m, check: mrz.check, source: 'mrz', confidence: Math.min(mrz.confidence, 0.9) };
  if (p) return { value: p, check: mrz.value ? mrz.check : 'absent', source: 'zone_imprimee', confidence: DISAGREEMENT_CONFIDENCE };
  return { value: null, check: 'absent', source: null, confidence: 0 };
}

function mergeChecked(
  mrz: MrzReading['fields']['document_number'],
  printed: string | null,
): MergedField {
  if (!mrz.value || mrz.check === 'fausse') {
    return printed
      ? { value: printed, check: mrz.value ? 'fausse' : 'absent', source: 'zone_imprimee', confidence: DISAGREEMENT_CONFIDENCE }
      : { value: null, check: mrz.value ? 'fausse' : 'absent', source: null, confidence: 0 };
  }
  const agree = printed !== null && compact(printed) === compact(mrz.value);
  if (agree) return { value: mrz.value, check: mrz.check, source: 'concordants', confidence: 0.99 };
  if (mrz.check === 'juste' && mrz.confidence >= SURE_CONFIDENCE) {
    return { value: mrz.value, check: mrz.check, source: 'mrz', confidence: mrz.confidence };
  }
  // Corrigé par les clés, ou protégé faiblement : sûr seulement si la zone imprimée concorde.
  return {
    value: mrz.value,
    check: mrz.check,
    source: 'mrz',
    confidence: printed === null ? Math.min(mrz.confidence, 0.9) : DISAGREEMENT_CONFIDENCE,
  };
}

function fromMrz(f: MrzReading['fields']['date_of_birth']): MergedField {
  if (!f.value || f.check === 'fausse') return { value: null, check: f.value ? 'fausse' : 'absent', source: null, confidence: 0 };
  return { value: f.value, check: f.check, source: 'mrz', confidence: f.confidence };
}

/**
 * Applique la lecture MRZ à `ocrData` (modifié en place) et renvoie le détail champ par champ.
 * Les alias attendus par l'API (`full_name`, `id_number`, `expiry_date`) suivent.
 */
export function mergeMrzIntoOcr(ocrData: OCRData, reading: MrzReading): MergedFields {
  const printed = readPrintedZone(ocrData.raw_text ?? '');
  const f = reading.fields;

  const permit = reading.format === 'FRENCH_DRIVING_LICENSE';
  const merged: MergedFields = {
    document_number: mergeChecked(f.document_number, printed.document_number),
    last_name: mergeName(f.last_name, printed.last_name, permit ? 8 : undefined),
    first_names: mergeName(f.first_names, printed.first_names),
    // Le permis n'a pas de date de naissance dans sa MRZ : la zone imprimée seule, non sûre.
    date_of_birth: f.date_of_birth.value || !printed.date_of_birth
      ? fromMrz(f.date_of_birth)
      : { value: printed.date_of_birth, check: 'absent', source: 'zone_imprimee', confidence: DISAGREEMENT_CONFIDENCE },
    expiry_date: fromMrz(f.expiry_date),
    nationality: fromMrz(f.nationality),
    sex: fromMrz(f.sex),
  };

  const scores = (ocrData.confidence_scores = ocrData.confidence_scores || {});
  const set = (key: string, field: MergedField) => {
    if (!field.value) {
      // La MRZ est lue mais ne confirme pas ce champ (clé fausse, ou absent) : la lecture du
      // fournisseur reste, mais jamais comme sûre (sa confiance OCR atteint souvent 0,99).
      if (ocrData[key]) scores[key] = Math.min(scores[key] ?? DISAGREEMENT_CONFIDENCE, DISAGREEMENT_CONFIDENCE);
      return;
    }
    ocrData[key] = field.value;
    scores[key] = field.confidence;
  };

  set('document_number', merged.document_number);
  set('date_of_birth', merged.date_of_birth);
  set('expiration_date', merged.expiry_date);
  set('nationality', merged.nationality);
  set('sex', merged.sex);
  set('last_name', merged.last_name);
  set('first_name', merged.first_names);

  if (merged.last_name.value) {
    const full = [merged.first_names.value, merged.last_name.value].filter(Boolean).join(' ');
    ocrData.name = full;
    scores.name = Math.min(merged.last_name.confidence, merged.first_names.value ? merged.first_names.confidence : 1);
  }

  // Alias lus par l'API et par le banc : ils ne doivent jamais diverger des champs principaux.
  if (ocrData.name) ocrData.full_name = ocrData.name;
  if (ocrData.document_number) ocrData.id_number = ocrData.document_number;
  if (ocrData.expiration_date) ocrData.expiry_date = ocrData.expiration_date;

  return merged;
}

/**
 * Recto sans MRZ (CNI 2021, permis, pièces étrangères) : aucune clé de contrôle ne vérifie la zone
 * imprimée, donc aucun champ d'identité n'est présenté comme sûr, quelle que soit la confiance de
 * l'OCR (le banc a vu « 4LPARDOAP » pour « 4LPARD0AP » à 0,96). La vérification vient du verso.
 */
export const UNCHECKED_CONFIDENCE = 0.9;
const IDENTITY_FIELDS = ['document_number', 'name', 'last_name', 'first_name', 'date_of_birth', 'expiration_date', 'nationality', 'sex'];

export function capUncheckedConfidences(ocrData: OCRData): void {
  const scores = ocrData.confidence_scores;
  if (!scores) return;
  for (const key of IDENTITY_FIELDS) {
    if (typeof scores[key] === 'number') scores[key] = Math.min(scores[key], UNCHECKED_CONFIDENCE);
  }
}
