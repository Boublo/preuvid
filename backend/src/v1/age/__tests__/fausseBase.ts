/**
 * Base en mémoire pour les tests du passe : juste ce que le client PgQueryBuilder offre et que le
 * code du passe et des mesures utilisent (select, insert, update, delete avec RETURNING, filtres eq/gt/gte/lt/lte/is/not is).
 */

type Ligne = Record<string, any>;
type Filtre = (l: Ligne) => boolean;

export function fausseBase(clesPrimaires: Record<string, string> = {}) {
  const tables = new Map<string, Ligne[]>();
  const table = (nom: string) => { if (!tables.has(nom)) tables.set(nom, []); return tables.get(nom)!; };

  function from(nom: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let donnees: any = null;
    const filtres: Filtre[] = [];
    let tri: { col: string; asc: boolean } | null = null;
    let limite: number | null = null;
    let unique: 'single' | 'maybe' | null = null;

    const executer = () => {
      const lignes = table(nom);
      if (op === 'insert') {
        const nouvelles = (Array.isArray(donnees) ? donnees : [donnees]).map((d: Ligne): Ligne => ({ id: crypto.randomUUID(), ...d }));
        const pk = clesPrimaires[nom] ?? 'id';
        for (const n of nouvelles) {
          if (lignes.some(l => l[pk] === n[pk])) return { data: null, error: { message: 'duplicate key', code: '23505' } };
        }
        lignes.push(...nouvelles);
        return conclure(nouvelles);
      }
      const choisies = lignes.filter(l => filtres.every(f => f(l)));
      if (op === 'update') { for (const l of choisies) Object.assign(l, donnees); return conclure(choisies); }
      if (op === 'delete') { tables.set(nom, lignes.filter(l => !choisies.includes(l))); return conclure(choisies); }
      let r = [...choisies];
      if (tri) r.sort((a, b) => (a[tri!.col] < b[tri!.col] ? -1 : a[tri!.col] > b[tri!.col] ? 1 : 0) * (tri!.asc ? 1 : -1));
      if (limite !== null) r = r.slice(0, limite);
      return conclure(r);
    };
    const conclure = (r: Ligne[]) => {
      const copie = r.map(l => ({ ...l }));
      if (unique === 'single') return copie.length === 1 ? { data: copie[0], error: null } : { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
      if (unique === 'maybe') return { data: copie[0] ?? null, error: null };
      return { data: copie, error: null };
    };

    const q: any = {
      select: () => q,
      insert: (d: any) => { op = 'insert'; donnees = d; return q; },
      update: (d: any) => { op = 'update'; donnees = d; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (c: string, v: any) => { filtres.push(l => l[c] === v); return q; },
      gt: (c: string, v: any) => { filtres.push(l => l[c] > v); return q; },
      gte: (c: string, v: any) => { filtres.push(l => l[c] >= v); return q; },
      lt: (c: string, v: any) => { filtres.push(l => l[c] < v); return q; },
      lte: (c: string, v: any) => { filtres.push(l => l[c] <= v); return q; },
      is: (c: string, v: any) => { filtres.push(l => (l[c] ?? null) === v); return q; },
      not: (c: string, o: string, v: any) => {
        if (o !== 'is') throw new Error(`fausseBase : not(${o}) non géré`);
        filtres.push(l => (l[c] ?? null) !== v); return q;
      },
      order: (c: string, o?: { ascending?: boolean }) => { tri = { col: c, asc: o?.ascending !== false }; return q; },
      limit: (n: number) => { limite = n; return q; },
      single: () => { unique = 'single'; return q; },
      maybeSingle: () => { unique = 'maybe'; return q; },
      then: (ok: any, ko: any) => Promise.resolve().then(executer).then(ok, ko),
    };
    return q;
  }

  return { from, table, tables };
}
