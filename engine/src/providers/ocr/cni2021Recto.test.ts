import { describe, expect, it, vi } from 'vitest';
import { PaddleOCRProvider, findSpacedDmyDates } from './PaddleOCRProvider.js';

// Lignes lues par le moteur sur le recto synthétique du banc (preuvid/banc/gen.py, render_cni2021_recto).
// Identité inventée : aucune donnée réelle.
const RECTO_2021 = [
  'RÉPUBLIQUE FRANÇAISE',
  "CARTE NATIONALE D'IDENTITÉ / IDENTITY CARD",
  'N° du document / Document No',
  '4LPARD0AP',
  'NOM / Surname',
  'LEFEBVRE',
  'Prénoms / Given names',
  'JEAN, PIERRE',
  'SEXE / Sex NATIONALITÉ / Nationality DATE DE NAISS. / Date of birth',
  'M FRA 08 01 1952',
  'LIEU DE NAISSANCE / Place of birth',
  'NANTES (44)',
  "DATE D'EXPIR. / Expiry date",
  '16 06 2033',
  'Signature',
  '294570',
];

async function lire(textes: string[]) {
  const lines = textes.map((text, i) => [{ text, confidence: 0.98, box: { x: 40, y: 30 + i * 40, width: 400, height: 30 } }]);
  const recognize = vi.fn().mockResolvedValue({ text: textes.join('\n'), lines, confidence: 0.98 });
  const provider = new PaddleOCRProvider();
  (provider as any).service = { recognize };
  return provider.processDocument(Buffer.from([1, 2, 3]), 'national_id', 'FR');
}

describe('recto de la CNI 2021', () => {
  it('lit le nom, les prénoms, la date de naissance, la date d’expiration et le numéro', async () => {
    const o: any = await lire(RECTO_2021);
    expect(o.full_name ?? o.name).toBe('JEAN PIERRE LEFEBVRE');
    expect(o.date_of_birth).toBe('1952-01-08');
    expect(o.expiry_date ?? o.expiration_date).toBe('2033-06-16');
    expect(o.id_number ?? o.document_number).toBe('4LPARD0AP');
  });

  it('carte de 1995 sans libellés anglais : nom et date lus comme avant', async () => {
    const o: any = await lire(['RÉPUBLIQUE FRANÇAISE', "CARTE NATIONALE D'IDENTITÉ N° : 880692310285",
      'Nom : MARTIN', 'Prénom(s) : CLAIRE, ANNE', 'Né le : 14.03.1979']);
    expect(o.date_of_birth).toBe('1979-03-14');
    expect(o.full_name ?? o.name).toContain('MARTIN');
  });
});

describe('dates « JJ MM AAAA »', () => {
  it('garde les dates plausibles seulement', () => {
    expect(findSpacedDmyDates('M FRA 08 01 1952')).toEqual(['1952-01-08']);
    expect(findSpacedDmyDates('16  06 2033 Signature')).toEqual(['2033-06-16']);
    expect(findSpacedDmyDates('32 01 1952')).toEqual([]);
    expect(findSpacedDmyDates('08 13 1952')).toEqual([]);
    expect(findSpacedDmyDates('08 01 1852')).toEqual([]);
  });

  it('ne coupe pas une suite de chiffres plus longue', () => {
    expect(findSpacedDmyDates('1 08 01 19520')).toEqual([]);
    expect(findSpacedDmyDates('123 08 01 1952')).toEqual(['1952-01-08']);
    expect(findSpacedDmyDates('12.08 01 1952')).toEqual([]);
    expect(findSpacedDmyDates('06 12 34 56 78')).toEqual([]);
  });
});
