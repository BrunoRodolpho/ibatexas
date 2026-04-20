/**
 * Shared symmetric wave paths used by the curved text banner and
 * the orange section top edge — keeps them visually matched.
 *
 * Gentle S-curve: rises to Y=70 at 1/4, returns to Y=40 at 1/2,
 * dips to Y=10 at 3/4, and returns to Y=40 at the end.
 */
export const WAVE_CURVE = 'M0,40 Q360,70 720,40 Q1080,10 1440,40'

/**
 * Same curve as a closed fill path — fills from top edge (Y=0) down to the wave.
 * Used at the top of the orange section to create the curved edge.
 */
export const WAVE_FILL = 'M0,0 L0,40 Q360,70 720,40 Q1080,10 1440,40 L1440,0 Z'
