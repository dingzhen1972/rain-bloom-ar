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
    color: [232, 241, 255],
    alphaNear: [0.08, 0.14],   // drops right in front of the lens (out of focus)
    alphaOnPerson: 0.7,         // drops that land on the head / shoulders
    alphaFar: [0.86, 0.36],     // from 0.5 m to the far distance (fog)
    dropWidth: 0.0019,          // physical drop diameter in metres (drives on-screen thickness)
    darkHalo: 0.16,             // soft dark edge that keeps rain readable on bright walls
    glint: [255, 235, 200],     // colour a drop flashes when a "ha" reaches it
  },
  splash: { color: [228, 240, 255], alpha: 0.55, glintAlpha: 0.55 },
  ember: {
    colors: [[255, 190, 90], [255, 190, 90], [255, 140, 60], [255, 244, 225], [255, 170, 120]],
    life: [1.8, 3.0], size: 3.2, halo: 3.6, haloAlpha: 0.26,
  },
  // each raindrop that ignites opens into a tiny golden floret (pre-rendered rays, no extra particles)
  flare: { core: [255, 245, 220], mid: [255, 190, 110], life: 0.42, size: 4.2, rays: 6 },
  mouthGlow: { color: [255, 190, 120], pulseAlpha: 0.22, laughAlpha: 0.55 },
  fireworks: {
    colors: {
      gold: [255, 190, 90], amber: [255, 140, 60], white: [255, 244, 225], silver: [205, 220, 255],
      red: [255, 78, 64], rose: [255, 110, 160], violet: [180, 130, 255], cyan: [110, 215, 255], green: [140, 255, 170],
    },
    radius: 0.36,            // burst radius as a fraction of frame width (size 1)
    trailWidth: 2.0, trailGlowWidth: 8, headSize: 2.5,
    beads: true,             // trails drawn as glittering dotted lines (the "golden rain" look)
    beadSize: 3.2,           // bead size in design px (older beads are drawn smaller)
    headGlow: 4.5,           // soft glow around fresh star heads (high/mid tiers only)
    fade: [255, 104, 52],    // colour a star cools to before it dies (gold → amber → ember red)
    pistil: [255, 250, 238], // white-hot inner core of the grand shell
    bloomGlow: [255, 196, 110], bloomGlowAlpha: 0.32,   // warm light that lingers where the grand shell opened
    smoke: [150, 150, 175], smokeAlpha: 0.1,
    flashAlpha: 0.22,        // how much each burst lights the whole scene (and the person)
    // [seconds after the laugh, preferred x, preferred y, colour, size, kind]
    // x can be 'main': beside the head, on its roomier side, partly behind the person.
    // kinds: grand (big beaded gold peony with a white core), brocade, chrys, peony, willow, ring,
    //        cascade (bursts in front of the person; its sparks land on the head and shoulders)
    // One big gold bloom first, then the rest open one after another around it.
    plan: [
      [1.15, 'main', 0.22, 'gold', 1.6, 'grand'],
      [1.85, 0.16, 0.30, 'white', 0.62, 'chrys'],
      [2.20, 0.84, 0.26, 'silver', 0.66, 'chrys'],
      [2.85, 0.50, 0.10, 'gold', 1.45, 'willow'],
      [3.45, 0.20, 0.20, 'gold', 0.7, 'peony'],
      [3.75, 0.80, 0.18, 'amber', 0.7, 'peony'],
      [4.35, 'head', 'aboveHead', 'gold', 1.0, 'cascade'],
      [4.60, 0.30, 0.16, 'white', 0.55, 'chrys'],
      [4.75, 0.72, 0.14, 'white', 0.55, 'chrys'],
    ],
  },
  grade: {                    // multiply tint at full strength, sky darkening, vignette
    rainLevel: 0.38, bloomLevel: 0.92,
    tint: [165, 150, 112], skyTint: [205, 198, 165], vignette: [3, 5, 14], vignetteAlpha: [0.32, 0.33],
  },
  hud: {
    hintSmile: '微笑一下，开始下雨', hintLaugh: '笑出声，让雨变成烟花',
    bar: [235, 244, 255], barHot: [255, 205, 120], words: { still: '静', smile: '雨', laugh: '哈', bloom: '花' },
  },
};
