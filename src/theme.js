// ─────────────────────────────────────────────────────────────────────────────
// THEME —— everything you see, in one place.
// Change colours, sizes, counts, firework choreography and the colour grade here.
// Physics, detection, timing logic and performance tiers never read anything from this file
// except through the names below, so a new look cannot break the interaction.
// Units: lengths are in "design pixels" for a 1080-wide frame (scaled automatically),
//        colours are [r, g, b], alphas are 0..1, times are seconds.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME = {
  rain: {
    color: [220, 232, 250],
    alphaNear: [0.08, 0.14],   // drops right in front of the lens (out of focus)
    alphaOnPerson: 0.62,        // drops that land on the head / shoulders
    alphaFar: [0.72, 0.3],      // from 0.5 m to the far distance (fog)
    dropWidth: 0.0019,          // physical drop diameter in metres (drives on-screen thickness)
    darkHalo: 0.16,             // soft dark edge that keeps rain readable on bright walls
    glint: [255, 235, 200],     // colour a drop flashes when a "ha" reaches it
  },
  splash: { color: [228, 240, 255], alpha: 0.55, glintAlpha: 0.55 },
  ember: {
    colors: [[255, 190, 90], [255, 190, 90], [255, 140, 60], [255, 244, 225], [255, 170, 120]],
    life: [1.8, 3.0], size: 3.2, halo: 3.6, haloAlpha: 0.26,
  },
  flare: { core: [255, 245, 220], mid: [255, 190, 110] },
  mouthGlow: { color: [255, 190, 120], pulseAlpha: 0.22, laughAlpha: 0.55 },
  fireworks: {
    colors: {
      gold: [255, 190, 90], amber: [255, 140, 60], white: [255, 244, 225], silver: [205, 220, 255],
      red: [255, 78, 64], rose: [255, 110, 160], violet: [180, 130, 255], cyan: [110, 215, 255], green: [140, 255, 170],
    },
    radius: 0.36,            // burst radius as a fraction of frame width (size 1)
    trailWidth: 1.8, trailGlowWidth: 7, headSize: 2.3,
    smoke: [150, 150, 175], smokeAlpha: 0.1,
    flashAlpha: 0.2,         // how much each burst lights the whole scene (and the person)
    // [seconds after the laugh, preferred x, preferred y, colour, size, kind]
    // kinds: brocade, chrys, peony, willow, ring, cascade (cascade bursts in front of the person and its sparks land on them)
    plan: [
      [1.25, 0.28, 0.20, 'gold', 1.0, 'brocade'],
      [1.80, 0.76, 0.24, 'red', 0.9, 'peony'],
      [2.30, 0.54, 0.14, 'gold', 1.1, 'willow'],
      [2.85, 0.18, 0.30, 'silver', 0.85, 'chrys'],
      [3.20, 0.82, 0.30, 'rose', 0.85, 'peony'],
      [3.65, 0.40, 0.17, 'white', 1.0, 'chrys'],
      [3.80, 0.68, 0.18, 'violet', 0.85, 'ring'],
      [4.30, 0.50, 0.12, 'gold', 1.3, 'willow'],
      [4.55, 'head', 'aboveHead', 'gold', 1.0, 'cascade'],
      [4.60, 0.22, 0.22, 'gold', 0.8, 'brocade'],
      [4.70, 0.80, 0.22, 'gold', 0.8, 'brocade'],
    ],
  },
  grade: {                    // multiply tint at full strength, sky darkening, vignette
    rainLevel: 0.35, bloomLevel: 0.85,
    tint: [165, 150, 112], skyTint: [205, 198, 165], vignette: [3, 5, 14], vignetteAlpha: [0.32, 0.33],
  },
  hud: {
    hintSmile: '微笑一下，开始下雨', hintLaugh: '笑出声，让雨变成烟花',
    bar: [235, 244, 255], barHot: [255, 205, 120], words: { still: '静', smile: '雨', laugh: '哈', bloom: '花' },
  },
};
