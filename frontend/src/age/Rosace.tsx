/**
 * Rosace guillochée (preuvid/docs/design.md, maquettes 08 à 10) : trois anneaux de brins entrelacés,
 * r = R + A·sin(k·t + 2πj/n), qui tournent lentement chacun à son rythme. Décorative : cachée aux
 * lecteurs d'écran ; immobile si l'appareil demande moins d'animations.
 */

const C = 130;
const PAS = 220;

function anneau(rayon: number, amplitude: number, lobes: number, brins: number): string[] {
  const chemins: string[] = [];
  for (let j = 0; j < brins; j++) {
    const phase = (2 * Math.PI * j) / brins;
    let d = '';
    for (let i = 0; i <= PAS; i++) {
      const t = (2 * Math.PI * i) / PAS;
      const r = rayon + amplitude * Math.sin(lobes * t + phase);
      d += `${i ? 'L' : 'M'}${(C + r * Math.cos(t)).toFixed(1)} ${(C + r * Math.sin(t)).toFixed(1)}`;
    }
    chemins.push(d);
  }
  return chemins;
}

const ANNEAUX = [anneau(118, 10, 12, 6), anneau(92, 14, 9, 5), anneau(60, 12, 6, 4)];

export function Rosace({ couleur = 'currentColor', className = '' }: { couleur?: string; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 260 260" className={`rosace ${className}`}
      fill="none" stroke={couleur} strokeWidth={0.6}>
      {ANNEAUX.map((chemins, i) => (
        <g key={i} className={`rg rg${i}`}>
          {chemins.map((d, j) => <path key={j} d={d} />)}
        </g>
      ))}
    </svg>
  );
}
