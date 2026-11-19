/**
 * Lecture tolérante de la bande MRZ (lot 1 Preuvid).
 *
 * L'OCR rend souvent une MRZ presque juste : quelques `<` de remplissage perdus ou en trop,
 * un `«` à la place d'un `<`, un O lu à la place d'un 0. Ce module :
 *   1. repère dans le texte brut les lignes qui ressemblent à une MRZ ;
 *   2. les remet à la longueur du format (TD1 3×30, CNI française 2×36, TD2 2×36, TD3 2×44)
 *      en n'allongeant ou en ne raccourcissant que les suites de `<` existantes ;
 *   3. décode avec la bibliothèque `mrz` et garde la seule variante dont les clés de contrôle
 *      sont justes ;
 *   4. si une clé reste fausse, essaie une confusion usuelle (O/0, I/1, B/8, S/5, Z/2, G/6)
 *      sur le champ en cause. La correction n'est retenue que si une seule variante rend
 *      toutes les clés justes. Un champ dont la clé est juste n'est jamais modifié.
 *
 * Chaque champ sort avec son statut : `juste` (couvert par une clé juste), `corrigee`
 * (couvert, après correction de caractères), `fausse` (une clé qui le couvre est fausse),
 * `sans_cle` (aucune clé ne le couvre : nom du passeport, nationalité, sexe…).
 */

import { parse as parseMRZ } from 'mrz';
import type { ParseResult } from 'mrz';

export type FieldCheck = 'juste' | 'corrigee' | 'fausse' | 'sans_cle';

export interface MrzFieldReading {
  value: string | null;
  check: FieldCheck;
  confidence: number;
}

export interface MrzReading {
  format: string;
  /** Lignes après réparation (longueur et caractères). */
  lines: string[];
  /** Lignes telles que lues par l'OCR, après simple nettoyage. */
  ocr_lines: string[];
  /** Toutes les clés de contrôle sont justes (après correction éventuelle). */
  valid: boolean;
  /** Corrections de caractères appliquées (bibliothèque ou confusions usuelles). */
  corrections: { line: number; column: number; original: string; corrected: string }[];
  fields: {
    document_number: MrzFieldReading;
    last_name: MrzFieldReading;
    first_names: MrzFieldReading;
    date_of_birth: MrzFieldReading;
    expiry_date: MrzFieldReading;
    nationality: MrzFieldReading;
    issuing_country: MrzFieldReading;
    sex: MrzFieldReading;
  };
}

const CONFIDENCE: Record<FieldCheck, number> = {
  juste: 0.99,
  corrigee: 0.95,
  sans_cle: 0.9,
  fausse: 0.3,
};

interface Format { lines: number; length: number }
const FORMATS: Format[] = [
  { lines: 3, length: 30 },
  { lines: 2, length: 36 },
  { lines: 2, length: 44 },
  // Permis de conduire français (modèle 2013) : une ligne « D1FRA… » au verso.
  { lines: 1, length: 30 },
];

/** Écart de longueur toléré entre la ligne lue et le format. */
const MAX_LENGTH_GAP = 8;
/** Plafond de variantes par ligne et de combinaisons par bloc. */
const MAX_VARIANTS_PER_LINE = 60;
const MAX_COMBINATIONS = 6000;

// Caractères que l'OCR rend à la place de `<`.
const FILLER_LOOKALIKES = /[«‹≤(\[{]/g;

/** Nettoie une ligne d'OCR ; renvoie null si elle ne peut pas être une ligne de MRZ. */
export function normalizeMrzLine(raw: string): string | null {
  const s = raw
    .toUpperCase()
    .replace(FILLER_LOOKALIKES, '<')
    .replace(/\s+/g, '');
  // Ligne des noms très tronquée (« IDFRALEFEBVRE<<<<SS ») : acceptée dès 12 caractères si elle
  // contient un double `<`, elle sera complétée par cleanNameLine.
  const minLength = s.includes('<<') ? 12 : 30 - MAX_LENGTH_GAP;
  if (s.length < minLength || s.length > 44 + MAX_LENGTH_GAP) return null;
  if (!/^[A-Z0-9<]+$/.test(s)) return null;
  // Une ligne de MRZ contient presque toujours du remplissage ; sans `<`, il faut au moins
  // une majorité de chiffres (ligne 2 d'un TD1 pleine, par exemple).
  if (!s.includes('<') && (s.match(/\d/g)?.length ?? 0) < s.length / 2) return null;
  return s;
}

interface Run { start: number; length: number }

function fillerRuns(s: string): Run[] {
  const runs: Run[] = [];
  const re = /<+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) runs.push({ start: m.index, length: m[0].length });
  return runs;
}

function resizeRuns(s: string, runs: Run[], deltas: number[]): string {
  let out = '';
  let pos = 0;
  runs.forEach((r, i) => {
    out += s.slice(pos, r.start) + '<'.repeat(r.length + deltas[i]);
    pos = r.start + r.length;
  });
  return out + s.slice(pos);
}

/**
 * Variantes d'une ligne à la longueur voulue, en ne touchant qu'aux suites de `<`.
 * Ordre : la dernière suite d'abord (le remplissage final est le plus souvent tronqué),
 * puis une autre suite seule, puis deux suites. Une suite ne disparaît jamais.
 */
export function fitLineVariants(s: string, length: number): string[] {
  const gap = length - s.length;
  if (gap === 0) return [s];
  if (Math.abs(gap) > MAX_LENGTH_GAP) return [];

  let runs = fillerRuns(s);
  let base = s;
  if (gap > 0 && (runs.length === 0 || runs[runs.length - 1].start + runs[runs.length - 1].length !== s.length)) {
    // Remplissage final entièrement perdu : on le recrée en bout de ligne.
    base = s + '<';
    runs = fillerRuns(base);
    return fitLineVariants(base, length);
  }
  if (runs.length === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (deltas: number[]) => {
    if (runs.some((r, i) => r.length + deltas[i] < 1)) return;
    const v = resizeRuns(base, runs, deltas);
    if (v.length === length && !seen.has(v)) { seen.add(v); out.push(v); }
  };

  const order = runs.map((_, i) => runs.length - 1 - i);
  for (const i of order) {
    const d = runs.map(() => 0); d[i] = gap; push(d);
  }
  const step = gap > 0 ? 1 : -1;
  for (const i of order) {
    for (const j of order) {
      if (j >= i) continue;
      for (let a = step; Math.abs(a) < Math.abs(gap); a += step) {
        const d = runs.map(() => 0); d[i] = a; d[j] = gap - a; push(d);
        if (out.length >= MAX_VARIANTS_PER_LINE) return out;
      }
    }
  }
  return out.slice(0, MAX_VARIANTS_PER_LINE);
}

function safeParse(lines: string[]): ParseResult | null {
  try {
    return parseMRZ(lines, { autocorrect: true });
  } catch {
    return null;
  }
}

const isCheckField = (f: string | null) => !!f && f.endsWith('CheckDigit');

function checkScore(r: ParseResult): number {
  return r.details.filter(d => isCheckField(d.field) && d.valid).length
    - r.details.filter(d => isCheckField(d.field) && !d.valid).length;
}

// Champs dont l'invalidité (code pays inconnu, chiffre dans un nom) ne remet pas en cause les
// autres : ils sont signalés `fausse` un par un, sans invalider toute la lecture.
const SOFT_FIELDS = new Set(['issuingState', 'nationality', 'lastName', 'firstName']);

function allChecksValid(r: ParseResult): boolean {
  const checks = r.details.filter(d => isCheckField(d.field));
  return checks.length > 0
    && checks.every(d => d.valid)
    && r.details.every(d => d.valid || !d.field || SOFT_FIELDS.has(d.field));
}

/** Valeurs des champs protégés par une clé : deux lectures justes doivent les partager. */
function protectedSignature(r: ParseResult): string {
  return r.details
    .filter(d => d.field && isCovered(r, d.line, d.start, d.end))
    .map(d => `${d.field}=${d.value ?? ''}`)
    .join('|');
}

function isCovered(r: ParseResult, line: number, start: number, end: number): boolean {
  if (end <= start) return false;
  return r.details.some(d =>
    isCheckField(d.field) &&
    (d.ranges ?? []).slice(1).some(g => g.line === line && g.start <= start && g.end >= end),
  );
}

// Confusions usuelles, dans les deux sens.
const CONFUSIONS: Record<string, string[]> = {
  '0': ['O', 'D', 'Q'], O: ['0'], D: ['0'], Q: ['0'],
  '1': ['I', 'L'], I: ['1'], L: ['1'],
  '8': ['B'], B: ['8'],
  '5': ['S'], S: ['5'],
  '2': ['Z'], Z: ['2'],
  '6': ['G'], G: ['6'],
};

/** Chiffre lu dans une zone qui n'admet que des lettres (nom du permis). */
const DIGIT_TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B' };

/**
 * Corrige par les clés : sur chaque zone couverte par une clé fausse, essaie une substitution.
 * Renvoie la lecture corrigée seulement si elle est unique. Pas de double substitution : sur le
 * banc, elle trouvait des lectures justes au sens des clés mais fausses (TK21Z lu TK2ZZ, rendu TKZ2Z).
 */
function repairByCheckDigits(lines: string[], parsed: ParseResult): { lines: string[]; parsed: ParseResult } | null {
  const failing = parsed.details.filter(d => isCheckField(d.field) && !d.valid);
  if (failing.length === 0) return null;

  // Positions candidates : les caractères couverts par une clé fausse, hors positions
  // couvertes par une clé juste (on ne modifie jamais un champ dont la clé est juste).
  const validRanges = parsed.details
    .filter(d => isCheckField(d.field) && d.valid)
    .flatMap(d => d.ranges ?? []);
  const lockedPos = new Set<string>();
  for (const g of validRanges) for (let c = g.start; c < g.end; c++) lockedPos.add(`${g.line}:${c}`);

  const positions: { line: number; col: number }[] = [];
  const seenPos = new Set<string>();
  for (const d of failing) {
    for (const g of d.ranges ?? []) {
      for (let c = g.start; c < g.end; c++) {
        const k = `${g.line}:${c}`;
        if (lockedPos.has(k) || seenPos.has(k)) continue;
        if (!CONFUSIONS[lines[g.line][c]]) continue;
        seenPos.add(k);
        positions.push({ line: g.line, col: c });
      }
    }
  }
  if (positions.length === 0 || positions.length > 24) return null;

  const substitute = (src: string[], subs: { line: number; col: number; ch: string }[]) => {
    const out = [...src];
    for (const s of subs) out[s.line] = out[s.line].slice(0, s.col) + s.ch + out[s.line].slice(s.col + 1);
    return out;
  };

  const solutions = new Map<string, { lines: string[]; parsed: ParseResult }>();
  const tryCandidate = (cand: string[]) => {
    const r = safeParse(cand);
    if (r && allChecksValid(r)) solutions.set(protectedSignature(r), { lines: cand, parsed: r });
  };

  for (const p of positions) {
    for (const ch of CONFUSIONS[lines[p.line][p.col]]) tryCandidate(substitute(lines, [{ ...p, ch }]));
  }
  if (solutions.size !== 1) return null;
  return [...solutions.values()][0];
}

/** Choisit la meilleure lecture d'un bloc de lignes pour un format donné. */
/**
 * Ligne des noms (ligne 1 du passeport, ligne 3 de la CNI 2021) : aucune clé ne la couvre et
 * les noms sont recoupés avec la zone imprimée. On coupe au premier remplissage de 3 `<` ou plus
 * (les prénoms sont séparés par un seul `<`), ce qui retire le bruit de fin de ligne, puis on
 * complète de `<`, quel que soit le nombre de `<` perdus.
 */
export function cleanNameLine(line: string, length: number): string | null {
  const m = /<{3,}/.exec(line);
  const base = m ? line.slice(0, m.index) : line.replace(/<+$/, '');
  if (base.length >= length - 2) return null;
  return base.padEnd(length, '<');
}

const levenshtein1 = (a: string, b: string) => {
  // Vrai si b s'obtient de a par au plus une substitution, insertion ou suppression.
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};

/**
 * Code de l'État émetteur mal lu en tête de ligne 1 (« P<FAMOREAU », « P<F<AMOREAU ») :
 * on le rétablit d'après la nationalité de la ligne de données, s'il en diffère d'un caractère.
 * Le code de l'État n'est couvert par aucune clé ; il reste signalé comme tel.
 */
function repairHeader(lines: string[], format: Format): string[] {
  // Ancienne CNI : « IDFRA » lu « DFRA » ou « IFRA » (une lettre perdue en tête). La clé
  // composite de cette carte couvre la première ligne entière et tranche.
  if (format.length === 36 && lines.length === 2 && /^[ID]FRA/.test(lines[0])) {
    lines = ['IDFRA' + lines[0].slice(4), ...lines.slice(1)];
  }
  let stateLine: string | null = null;
  if (format.length === 44 && lines.length === 2) stateLine = lines[1].length >= 13 ? lines[1].slice(10, 13) : null;
  if (format.length === 30 && lines.length === 3) stateLine = lines[1].length >= 18 ? lines[1].slice(15, 18) : null;
  if (format.length === 36 && lines.length === 2 && lines[0].startsWith('ID')) {
    // TD2 : nationalité en ligne 2 ; CNI française : pas de nationalité, l'État est la France.
    const nat = lines[1].length >= 13 ? lines[1].slice(10, 13) : '';
    stateLine = /^[A-Z]{3}$/.test(nat) ? nat : 'FRA';
  }
  if (!stateLine || !/^[A-Z]{3}$/.test(stateLine)) return lines;
  const l0 = lines[0];
  if (l0.slice(2, 5) === stateLine) return lines;
  // TD1 : un titre de séjour est émis par la France pour un étranger, l'État émetteur diffère
  // normalement de la nationalité. On ne réécrit que si l'en-tête n'est pas trois lettres.
  if (format.length === 30 && /^[A-Z]{3}$/.test(l0.slice(2, 5))) return lines;
  for (const cut of [4, 5, 6]) {
    if (levenshtein1(l0.slice(2, cut), stateLine)) {
      return [l0.slice(0, 2) + stateLine + l0.slice(cut), ...lines.slice(1)];
    }
  }
  return lines;
}

/**
 * Ligne qui porte les noms : 1re ligne (passeport, CNI française d'avant 2021, TD2), 3e du TD1.
 * -1 pour le permis : son nom tronqué à 8 lettres est pris dans la ligne unique, sans traitement à part.
 */
function nameLineIndex(format: Format): number {
  if (format.lines === 1) return -1;
  return format.lines === 3 ? 2 : 0;
}

function readBlock(rawBlock: string[], format: Format): { lines: string[]; parsed: ParseResult; before: string[] } | null {
  const block = repairHeader(rawBlock, format);
  const nameLine = nameLineIndex(format);
  const variants = block.map((l, i) => {
    const v = fitLineVariants(l, format.length);
    // Permis : le nom (positions 21 à 28) ne contient pas de chiffres ; « 0KAF0R » se lit OKAFOR.
    // Variante en lettres essayée d'abord : la clé composite couvre le nom, mais elle peut valider
    // les deux lectures (c'est le cas de « 0KAF0R » / « OKAFOR »), et un nom n'a jamais de chiffre.
    if (format.lines === 1) {
      const letters = v.map(x => x.slice(0, 21) + x.slice(21, 29).replace(/[0-9]/g, d => DIGIT_TO_LETTER[d] ?? d) + x.slice(29));
      return [...new Set([...letters, ...v])];
    }
    if (i !== nameLine) return v;
    const cleaned = cleanNameLine(l, format.length);
    return cleaned && !v.includes(cleaned) ? [cleaned, ...v] : v;
  });
  if (variants.some(v => v.length === 0)) return null;

  // Produit cartésien plafonné ; la première ligne varie le plus lentement.
  const combos: string[][] = [];
  const build = (i: number, acc: string[]) => {
    if (combos.length >= MAX_COMBINATIONS) return;
    if (i === variants.length) { combos.push(acc); return; }
    for (const v of variants[i]) build(i + 1, [...acc, v]);
  };
  build(0, []);

  let best: { lines: string[]; parsed: ParseResult; score: number } | null = null;
  const validBySignature = new Map<string, { lines: string[]; parsed: ParseResult }>();
  for (const c of combos) {
    const r = safeParse(c);
    if (!r) continue;
    if (allChecksValid(r)) {
      const sig = protectedSignature(r);
      // Première variante gardée pour une même signature : l'ordre favorise le remplissage final.
      if (!validBySignature.has(sig)) validBySignature.set(sig, { lines: c, parsed: r });
      continue;
    }
    const s = checkScore(r);
    if (!best || s > best.score) best = { lines: c, parsed: r, score: s };
  }

  if (validBySignature.size === 1) {
    const v = [...validBySignature.values()][0];
    return { ...v, before: v.lines };
  }
  if (validBySignature.size > 1) {
    // Plusieurs lectures justes et différentes : ambiguïté, on ne tranche pas.
    const first = [...validBySignature.values()][0];
    return { lines: first.lines, parsed: { ...first.parsed, valid: false }, before: first.lines };
  }
  if (!best) return null;

  const fixed = repairByCheckDigits(best.lines, best.parsed);
  if (fixed) return { ...fixed, before: best.lines };
  return { lines: best.lines, parsed: best.parsed, before: best.lines };
}

function diffCorrections(before: string[], after: string[]) {
  const out: MrzReading['corrections'] = [];
  after.forEach((l, i) => {
    for (let c = 0; c < l.length; c++) {
      if (before[i][c] !== l[c]) out.push({ line: i, column: c, original: before[i][c], corrected: l[c] });
    }
  });
  return out;
}

function fieldReading(
  r: ParseResult,
  field: string,
  value: string | null,
  correctedPositions: Set<string>,
  resizedLines: Set<number> = new Set(),
): MrzFieldReading {
  const d = r.details.find(x => x.field === field);
  if (!d || value === null || value === '') return { value: value || null, check: 'sans_cle', confidence: 0 };
  const ranges = (x: ParseResult['details'][number]) => isCheckField(x.field) ? (x.ranges ?? []).slice(1) : [];
  const covering = r.details.filter(x => ranges(x).some(g => g.line === d.line && g.start <= d.start && g.end >= d.end));
  // Une clé qui ne couvre qu'une partie du champ compte aussi si elle est fausse : sur le banc, un
  // titre de séjour lu « IRFAMVB89… » (lettre perdue) donnait un numéro long « VB89YWPD7<<… »
  // dont la clé propre était fausse, mais que la seule clé composite, juste par hasard, validait.
  const overlapping = r.details.filter(x => ranges(x).some(g => g.line === d.line && g.start < d.end && g.end > d.start));
  let check: FieldCheck;
  if (!d.valid) check = 'fausse';
  else if (overlapping.some(x => !x.valid)) check = 'fausse';
  else if (covering.length === 0 || d.end <= d.start) check = 'sans_cle';
  else {
    let touched = (d.autocorrect ?? []).length > 0;
    for (let c = d.start; c < d.end && !touched; c++) if (correctedPositions.has(`${d.line}:${c}`)) touched = true;
    check = touched ? 'corrigee' : 'juste';
  }
  let confidence = CONFIDENCE[check];
  // Champ protégé par la seule clé composite (un chiffre, 1 chance sur 10 de passer par hasard)
  // sur une ligne dont on a refait la longueur : sur le banc, « MOREAU » lu « MOREU » puis
  // complété de < passait la clé. On ne le présente pas comme sûr.
  if ((check === 'juste' || check === 'corrigee') && resizedLines.has(d.line)
      && covering.every(x => x.field === 'compositeCheckDigit')) {
    confidence = CONFIDENCE.sans_cle;
  }
  return { value, check, confidence };
}

function toIsoDate(yymmdd: string | null | undefined, kind: 'birth' | 'expiry'): string | null {
  if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return null;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const current = new Date().getFullYear() % 100;
  const century = kind === 'birth' ? (yy > current ? '19' : '20') : (yy > current + 70 ? '19' : '20');
  return `${century}${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

function buildReading(ocrLines: string[], lines: string[], parsed: ParseResult, extra: MrzReading['corrections']): MrzReading {
  const libCorrections = parsed.details.flatMap(d => d.autocorrect ?? []).map(a => ({
    line: a.line, column: a.column, original: a.original, corrected: a.corrected,
  }));
  const corrections = [...extra, ...libCorrections];
  const corrected = new Set(corrections.map(c => `${c.line}:${c.column}`));
  const f = parsed.fields as Record<string, string | null | undefined>;
  const resized = new Set(lines.map((l, i) => (l.length !== ocrLines[i].length ? i : -1)).filter(i => i >= 0));

  // CNI française d'avant 2021 : le numéro imprimé fait 12 caractères (date d'émission,
  // code administratif, numéro), la bibliothèque le découpe en trois.
  let docNumber = f.documentNumber ?? null;
  let docField = 'documentNumber';
  if (parsed.format === 'FRENCH_NATIONAL_ID') {
    docNumber = lines[1].slice(0, 12);
    docField = 'documentNumberCheckDigit';
  }
  const sex = f.sex === 'male' ? 'M' : f.sex === 'female' ? 'F' : (f.sex ?? null);

  const docReading = fieldReading(parsed, docField, docNumber, corrected);
  if (docField === 'documentNumberCheckDigit') {
    // La clé du numéro couvre les 12 premiers caractères de la ligne 2.
    const d = parsed.details.find(x => x.field === 'documentNumberCheckDigit');
    const touched = [...Array(12).keys()].some(c => corrected.has(`1:${c}`));
    docReading.check = !d ? 'sans_cle' : !d.valid ? 'fausse' : touched ? 'corrigee' : 'juste';
    docReading.confidence = CONFIDENCE[docReading.check];
  }

  return {
    format: parsed.format,
    lines,
    ocr_lines: ocrLines,
    valid: allChecksValid(parsed),
    corrections,
    fields: {
      document_number: docReading,
      last_name: fieldReading(parsed, 'lastName', f.lastName ?? null, corrected, resized),
      first_names: fieldReading(parsed, 'firstName', f.firstName ?? null, corrected, resized),
      date_of_birth: { ...fieldReading(parsed, 'birthDate', f.birthDate ?? null, corrected), value: toIsoDate(f.birthDate, 'birth') },
      expiry_date: { ...fieldReading(parsed, 'expirationDate', f.expirationDate ?? null, corrected), value: toIsoDate(f.expirationDate, 'expiry') },
      nationality: fieldReading(parsed, 'nationality', f.nationality ?? null, corrected),
      issuing_country: fieldReading(parsed, 'issuingState', f.issuingState ?? null, corrected),
      sex: { ...fieldReading(parsed, 'sex', f.sex ?? null, corrected), value: sex },
    },
  };
}

/**
 * Repère et lit la MRZ d'un texte d'OCR (une ligne par ligne de texte).
 * Renvoie null si aucun bloc ne ressemble à une MRZ décodable.
 */
export function readMrzFromText(rawText: string): MrzReading | null {
  if (!rawText) return null;
  // Les lignes qui ne ressemblent pas à une MRZ (ligne vide, bruit) sont sautées : l'OCR en
  // intercale parfois entre deux lignes de la bande.
  const candidates = rawText.split('\n').map(normalizeMrzLine).filter((l): l is string => l !== null);

  let best: { reading: MrzReading; score: number } | null = null;
  for (const format of FORMATS) {
    for (let i = 0; i + format.lines <= candidates.length; i++) {
      const lines = candidates.slice(i, i + format.lines);
      const nameLine = nameLineIndex(format);
      if (lines.some((l, k) => k !== nameLine && Math.abs(l.length - format.length) > MAX_LENGTH_GAP)) continue;
      if (nameLine >= 0 && lines[nameLine].length > format.length + MAX_LENGTH_GAP) continue;
      // Ligne unique : seulement un permis (« D1 »), pour ne pas lire une ligne isolée de TD1.
      if (format.lines === 1 && !/^D[1I]/.test(lines[0])) continue;

      const read = readBlock(lines, format);
      if (!read) continue;
      const extra = diffCorrections(read.before, read.lines);
      const reading = buildReading(lines, read.lines, read.parsed, extra);
      const score = (reading.valid ? 1000 : 0) + checkScore(read.parsed) * 10
        - lines.reduce((a, l) => a + Math.abs(l.length - format.length), 0);
      if (!best || score > best.score) best = { reading, score };
    }
  }
  return best?.reading ?? null;
}
