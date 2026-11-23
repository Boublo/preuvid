import { describe, expect, it } from 'vitest';
import { readMrzFromText } from './mrzReader.js';
import { mergeMrzIntoOcr, readPrintedZone, SURE_CONFIDENCE } from './mrzMerge.js';

// Identité fictive du banc (preuvid/banc/gen.py).
const PASSEPORT = [
  'P<FRALEFEBVRE<<JEAN<PIERRE<<<<<<<<<<<<<<<<<<',
  '59EG764379FRA5201086M3306161<<<<<<<<<<<<<<02',
];

const recto = (nom: string, prenoms: string, mrz: string[]) => [
  'RÉPUBLIQUE FRANÇAISE',
  'Nom / Surname', nom,
  'Prénoms / Given names', prenoms,
  ...mrz,
].join('\n');

const fusion = (raw: string) => {
  const ocr: any = { raw_text: raw, confidence_scores: {} };
  const reading = readMrzFromText(raw)!;
  return { ocr, fields: mergeMrzIntoOcr(ocr, reading) };
};

describe('readPrintedZone', () => {
  it('lit les valeurs sous les libellés bilingues', () => {
    const z = readPrintedZone(recto('LEFEBVRE', 'JEAN, PIERRE', []));
    expect(z).toMatchObject({ last_name: 'LEFEBVRE', first_names: 'JEAN, PIERRE' });
  });
});

describe('mergeMrzIntoOcr', () => {
  it('présente comme sûrs les noms quand la MRZ et la zone imprimée concordent', () => {
    const { ocr, fields } = fusion(recto('LEFEBVRE', 'Jean, Pierre', PASSEPORT));
    expect(fields.last_name).toMatchObject({ value: 'LEFEBVRE', source: 'concordants' });
    expect(fields.first_names).toMatchObject({ value: 'JEAN PIERRE', source: 'concordants' });
    expect(fields.first_names.confidence).toBeGreaterThanOrEqual(SURE_CONFIDENCE);
    // Les alias lus par l'API suivent les champs principaux.
    expect(ocr.full_name).toBe('JEAN PIERRE LEFEBVRE');
    expect(ocr.id_number).toBe(ocr.document_number);
    expect(ocr.expiry_date).toBe('2033-06-16');
    expect(ocr.date_of_birth).toBe('1952-01-08');
  });

  it('garde la zone imprimée, avec une confiance basse, quand le nom diverge', () => {
    const { fields } = fusion(recto('LEFEVRE', 'JEAN PIERRE', PASSEPORT));
    expect(fields.last_name).toMatchObject({ value: 'LEFEVRE', source: 'zone_imprimee' });
    expect(fields.last_name.confidence).toBeLessThan(SURE_CONFIDENCE);
  });

  it('ne présente pas comme sûr un nom lu seulement dans la MRZ, sans clé', () => {
    const { fields } = fusion(['RÉPUBLIQUE FRANÇAISE', ...PASSEPORT].join('\n'));
    expect(fields.last_name).toMatchObject({ value: 'LEFEBVRE', source: 'mrz', check: 'sans_cle' });
    expect(fields.last_name.confidence).toBeLessThan(SURE_CONFIDENCE);
  });

  it("ne reprend pas de la MRZ une date dont la clé est fausse", () => {
    const fausse = [PASSEPORT[0], PASSEPORT[1].replace('5201086', '5201036')];
    const { ocr, fields } = fusion(recto('LEFEBVRE', 'JEAN PIERRE', fausse));
    expect(fields.date_of_birth).toMatchObject({ value: null, check: 'fausse' });
    expect(ocr.date_of_birth).toBeUndefined();
  });

  it("ne laisse pas sûre la date du fournisseur quand la MRZ la contredit", () => {
    const fausse = [PASSEPORT[0], PASSEPORT[1].replace('5201086', '5201036')];
    const raw = recto('LEFEBVRE', 'JEAN PIERRE', fausse);
    const ocr: any = { raw_text: raw, date_of_birth: '1952-08-01', confidence_scores: { date_of_birth: 0.99 } };
    mergeMrzIntoOcr(ocr, readMrzFromText(raw)!);
    expect(ocr.confidence_scores.date_of_birth).toBeLessThan(SURE_CONFIDENCE);
  });

  it('lit le permis : rubriques numérotées, nom tronqué dans la MRZ, naissance imprimée seulement', () => {
    const raw = [
      'PERMIS DE CONDUIRE', '1. DE LA FONTAINE', '2. MARIE CLAIRE', '3. 08.01.1952 GRENOBLE',
      '4b. 16.06.2033', '5. 18AB12345', 'D1FRA18AB123455330616DE<LA<FO8',
    ].join('\n');
    const { ocr, fields } = fusion(raw);
    expect(fields.document_number).toMatchObject({ value: '18AB12345', source: 'concordants' });
    expect(fields.last_name).toMatchObject({ value: 'DE LA FONTAINE', source: 'concordants' });
    // La fin du nom n'est couverte par aucune clé.
    expect(fields.last_name.confidence).toBeLessThan(SURE_CONFIDENCE);
    expect(fields.date_of_birth).toMatchObject({ value: '1952-01-08', source: 'zone_imprimee' });
    expect(fields.date_of_birth.confidence).toBeLessThan(SURE_CONFIDENCE);
    expect(ocr.expiry_date).toBe('2033-06-16');
    expect(ocr.full_name).toBe('MARIE CLAIRE DE LA FONTAINE');
  });

  it("garde les prénoms du permis quand l'OCR perd le numéro de rubrique", () => {
    // Banc, permis_05 : « 2. WEI » lu « . WEI ».
    const raw = ['PERMIS DE CONDUIRE', '1. CHEN', '. WEI', '3. 16.10.1954 GRENOBLE', '5. 19XT01904',
      'D1FRA19XT019044351106CHEN<<<<8'].join('\n');
    const { ocr, fields } = fusion(raw);
    expect(fields.first_names).toMatchObject({ value: 'WEI', source: 'zone_imprimee' });
    expect(fields.first_names.confidence).toBeLessThan(SURE_CONFIDENCE);
    expect(ocr.full_name).toBe('WEI CHEN');
  });
});

describe('recto sans MRZ', () => {
  it('aucun champ d’identité n’est présenté comme sûr ; les autres champs ne changent pas', async () => {
    const { capUncheckedConfidences, SURE_CONFIDENCE } = await import('./mrzMerge.js');
    const ocr: any = { document_number: '4LPARDOAP', confidence_scores: { document_number: 0.96, date_of_birth: 0.99, name: 0.5, address: 0.98 } };
    capUncheckedConfidences(ocr);
    expect(ocr.confidence_scores.document_number).toBeLessThan(SURE_CONFIDENCE);
    expect(ocr.confidence_scores.date_of_birth).toBeLessThan(SURE_CONFIDENCE);
    expect(ocr.confidence_scores.name).toBe(0.5);
    expect(ocr.confidence_scores.address).toBe(0.98);
  });
});
