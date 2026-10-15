// Pure scheduling for the tournament, so its fairness can be tested.
//  modes[slot]   : match m shifts the arm list by m mod N -> every arm sits in every join slot equally often
//  persona       : floor(m/N) mod P                       -> within N*P matches every (slot, persona) pair appears exactly once
//  followArm     : arms[(q + s) mod N], q = floor(m/N), s = m mod N -> every arm is followed once per N matches, in every persona block
// Which bot the camera follows never changes the game (the observer is invisible, non-solid and not targeted).
export function makePlan(arms, personas) {
  const N = arms.length;
  return (m) => {
    const s = m % N, q = Math.floor(m / N);
    const modes = arms.map((_, i) => arms[(i + s) % N]);
    const followArm = arms[(q + s) % N];
    return { modes, persona: personas[q % personas.length], followArm, followSlot: modes.indexOf(followArm) };
  };
}
