import { parse } from 'mrz';
const cases = {
 'CNI ancienne (2x36, specimen)': ['IDFRABERTHIER<<<<<<<<<<<<<<<<<<<<<<<','8806923102858CORINNE<<<<<<<6512068F6'],
 'CNI 2021 (TD1 3x30, specimen)': ['IDFRAX4RTBPFW46<<<<<<<<<<<<<<<','9007138F3002119FRA<<<<<<<<<<<6','MARTIN<<MAELYS<GAELLE<MARIE<<<'],
 'Passeport (TD3, specimen ICAO)': ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<','L898902C36UTO7408122F1204159ZE184226B<<<<<10'],
};
for (const [name, lines] of Object.entries(cases)) {
  try { const r = parse(lines, {autocorrect:true});
    console.log(`\n${name}\n  format=${r.format} valid=${r.valid}`);
    const f=r.fields; console.log('  ', JSON.stringify({doc:f.documentNumber, nom:f.lastName, prenom:f.firstName, naissance:f.birthDate, exp:f.expirationDate, nat:f.nationality, etat:f.issuingState, sexe:f.sex}));
    const bad = r.details.filter(d=>!d.valid).map(d=>`${d.label}: ${d.error}`); if(bad.length) console.log('   erreurs:', bad.join(' | '));
  } catch(e){ console.log(`\n${name}\n  ECHEC: ${e.message}`); }
}
