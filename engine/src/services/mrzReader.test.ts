import { describe, expect, it } from 'vitest';
import { fitLineVariants, normalizeMrzLine, readMrzFromText } from './mrzReader.js';

// Identités fictives du banc (preuvid/banc/gen.py).
const PASSEPORT = [
  'P<FRALEFEBVRE<<JEAN<PIERRE<<<<<<<<<<<<<<<<<<',
  '59EG764379FRA5201086M3306161<<<<<<<<<<<<<<02',
];
const CNI_2021 = [
  'IDFRA4LPARD0AP5<<<<<<<<<<<<<<<',
  '5201086M3306161FRA<<<<<<<<<<<0',
  'LEFEBVRE<<JEAN<PIERRE<<<<<<<<<',
];
const CNI_ANCIENNE = [
  'IDFRALEFEBVRE<<<<<<<<<<<<<<<<<<<<<<<',
  '1406139273174JEAN<PIERRE<<<5201086M5',
];

const PERMIS = ['D1FRA18AB123455330616LEFEBVRE8'];

const texte = (lignes: string[]) => ['RÉPUBLIQUE FRANCAISE', 'Nom / Surname', ...lignes].join('\n');

describe('normalizeMrzLine', () => {
  it('remplace les sosies de < et retire les espaces', () => {
    expect(normalizeMrzLine('p<fra lefebvre««jean<pierre<<<<<<<<<<<<<<<<<<')).toBe(PASSEPORT[0]);
  });
  it('écarte une ligne de texte ordinaire', () => {
    expect(normalizeMrzLine('Date de naissance / Date of birth')).toBeNull();
  });
});

describe('fitLineVariants', () => {
  it("n'allonge que les suites de <", () => {
    const v = fitLineVariants('P<FRALEFEBVRE<<JEAN<PIERRE<<<<<<<<<<', 44);
    expect(v[0]).toBe(PASSEPORT[0]);
    for (const l of v) {
      expect(l).toHaveLength(44);
      expect(l.replace(/<+/g, '<')).toBe('P<FRALEFEBVRE<JEAN<PIERRE<');
    }
  });
  it('raccourcit une suite trop longue', () => {
    expect(fitLineVariants(CNI_2021[2] + '<<', 30)).toContain(CNI_2021[2]);
  });
});

describe('readMrzFromText', () => {
  it('lit un passeport propre, prénoms compris', () => {
    const r = readMrzFromText(texte(PASSEPORT))!;
    expect(r.valid).toBe(true);
    expect(r.lines).toEqual(PASSEPORT);
    expect(r.fields.last_name.value).toBe('LEFEBVRE');
    expect(r.fields.first_names.value).toBe('JEAN PIERRE');
    expect(r.fields.document_number).toMatchObject({ value: '59EG76437', check: 'juste' });
    expect(r.fields.date_of_birth).toMatchObject({ value: '1952-01-08', check: 'juste' });
    expect(r.fields.expiry_date).toMatchObject({ value: '2033-06-16', check: 'juste' });
    expect(r.fields.sex.value).toBe('M');
    // Ligne 1 du passeport : aucune clé ne couvre le nom.
    expect(r.fields.last_name.check).toBe('sans_cle');
  });

  it('rétablit le remplissage perdu (passeport basse résolution)', () => {
    const r = readMrzFromText(texte(['P<FRALEFEBVRE<<JEAN<PIERRE<<<<<<<< <<<', PASSEPORT[1]]))!;
    expect(r.valid).toBe(true);
    expect(r.lines).toEqual(PASSEPORT);
  });

  it('rétablit le remplissage de la CNI ancienne, vérifié par la clé composite', () => {
    // Ligne des noms tronquée par l'OCR : on la complète avec des « < », la clé composite la vérifie.
    const r = readMrzFromText(texte(['IDFRALEFEBVRE<<<', CNI_ANCIENNE[1]]))!;
    expect(r.valid).toBe(true);
    expect(r.lines).toEqual(CNI_ANCIENNE);
    // Le nom n'est couvert que par la composite sur une ligne retaillée : jamais présenté comme sûr seul.
    expect(r.fields.last_name.confidence).toBeLessThan(0.95);
    const r2 = readMrzFromText(texte(['IDFRALEFEBVRE<<<<<<<<<<<<<<<<<<<<', CNI_ANCIENNE[1]]))!;
    expect(r2.valid).toBe(true);
    expect(r2.lines).toEqual(CNI_ANCIENNE);
    expect(r2.format).toBe('FRENCH_NATIONAL_ID');
    expect(r2.fields.document_number).toMatchObject({ value: '140613927317', check: 'juste' });
    expect(r2.fields.first_names).toMatchObject({ value: 'JEAN PIERRE', check: 'juste' });
  });

  it('lit la CNI 2021 (TD1)', () => {
    const r = readMrzFromText(texte(CNI_2021))!;
    expect(r.valid).toBe(true);
    expect(r.fields.document_number).toMatchObject({ value: '4LPARD0AP', check: 'juste' });
    expect(r.fields.first_names.value).toBe('JEAN PIERRE');
  });

  it('corrige un O lu à la place du 0 dans un numéro alphanumérique', () => {
    const lu = ['IDFRA4LPARDOAP5<<<<<<<<<<<<<<<', CNI_2021[1], CNI_2021[2]];
    const r = readMrzFromText(texte(lu))!;
    expect(r.valid).toBe(true);
    expect(r.lines).toEqual(CNI_2021);
    expect(r.fields.document_number).toMatchObject({ value: '4LPARD0AP', check: 'corrigee' });
    expect(r.corrections).toContainEqual({ line: 0, column: 11, original: 'O', corrected: '0' });
    // Les champs dont la clé était juste ne bougent pas.
    expect(r.fields.date_of_birth.check).toBe('juste');
  });

  it("ne présente pas comme sûr un champ dont la clé reste fausse", () => {
    // Chiffre faux (3 au lieu de 8) : aucune confusion usuelle ne le répare.
    const lu = [PASSEPORT[0], '59EG764379FRA5201036M3306161<<<<<<<<<<<<<<02'];
    const r = readMrzFromText(texte(lu))!;
    expect(r.valid).toBe(false);
    expect(r.fields.date_of_birth.check).toBe('fausse');
    expect(r.fields.date_of_birth.confidence).toBeLessThan(0.5);
    // Le numéro, couvert par sa propre clé juste mais aussi par la composite fausse, n'est pas sûr non plus.
    expect(r.fields.document_number.check).toBe('fausse');
  });

  it('renvoie null sans MRZ', () => {
    expect(readMrzFromText('RÉPUBLIQUE FRANCAISE\nNom / Surname\nLEFEBVRE')).toBeNull();
  });

  it('lit la ligne du permis de conduire (modèle 2013)', () => {
    const r = readMrzFromText(texte(PERMIS))!;
    expect(r.valid).toBe(true);
    expect(r.format).toBe('FRENCH_DRIVING_LICENSE');
    expect(r.fields.document_number).toMatchObject({ value: '18AB12345', check: 'juste' });
    expect(r.fields.expiry_date.value).toBe('2033-06-16');
    expect(r.fields.last_name.value).toBe('LEFEBVRE');
  });

  it("ne prend pas une ligne isolée de CNI 2021 pour un permis", () => {
    expect(readMrzFromText(texte([CNI_2021[0]]))).toBeNull();
  });

  it('ramène en lettres les chiffres lus dans le nom du permis', () => {
    // Banc, permis_04 : « OKAFOR » lu « 0KAF0R ».
    const r = readMrzFromText(texte(['D1FRA18NA3114653405100KAF0R<<3']))!;
    expect(r.valid).toBe(true);
    expect(r.lines[0]).toBe('D1FRA18NA311465340510OKAFOR<<3');
    expect(r.fields.last_name.value).toBe('OKAFOR');
  });

  it("garde l'État émetteur d'un titre de séjour quand la nationalité diffère", () => {
    const ts = [
      'IRFRAHP5DGMGX78<<<<<<<<<<<<<<<',
      '5410167F3511060BRA<<<<<<<<<<<4',
      'CHEN<<WEI<<<<<<<<<<<<<<<<<<<<<',
    ];
    expect(readMrzFromText(texte(ts))!.lines[0]).toBe(ts[0]);
  });

  it("rétablit l'en-tête IDFRA de l'ancienne CNI lu DFRA", () => {
    // Banc, cni_old_02 basse_resolution.
    const r = readMrzFromText(texte([
      'DFRAMOREAU<<<<<<<<<<<<<<<<<<<<<<<<<<',
      '1602664074567JEAN<PIERRE<<<9704264M5',
    ]))!;
    expect(r.valid).toBe(true);
    expect(r.lines[0]).toBe('IDFRAMOREAU<<<<<<<<<<<<<<<<<<<<<<<<<');
  });

  it("ne valide pas un numéro dont la clé propre est fausse, même si la composite passe", () => {
    // Banc, titre_sejour_00 sombre_bruit : « IRFRAMVB89YWPD7 » lu « IRFAMVB89YWPD7 ».
    const r = readMrzFromText(texte([
      'IRFAMVB89YWPD7<<<<<<<<<<<<<<<<',
      '0401098M3406289MAR<<<<<<<<<<<4',
      'BENALI<<CHIOMA<<<<<<<<<<<<<<<<',
    ]))!;
    expect(r.valid).toBe(false);
    expect(r.fields.document_number.check).toBe('fausse');
    expect(r.fields.document_number.confidence).toBeLessThan(0.95);
  });
});
