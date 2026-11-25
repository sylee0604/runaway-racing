# Final evidence — RUNAWAY CITY (pass-1)

Design: [game-design.md](game-design.md)

## Loaded skills
threejs-game-director, threejs-gameplay-systems (+ genre-design, physics-engine-selection, game-feel refs), threejs-aaa-graphics-builder, threejs-game-ui-designer, threejs-qa-release, evidence-manifest ref.
Credential probe: TRIPO/GEMINI/ELEVENLABS all MISSING → every model, texture and sound is procedural (no external assets).

## Checks run
| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `npm run build` | OK, 741 kB JS (198 kB gzip) |
| Playwright `tests/visual.spec.ts` (desktop keyboard W, mobile touch gas button; real Start button click) | 2/2 pass, no console/page errors |
| Canvas inspector, manifest `artifacts/evidence.json` (10 captures: title, active-play, heat-3, heat-5, tunnel, underpass, garage, game-over; mobile active-play, heat-3) | 10/10 PASS |
| `check_evidence.py --manifest` | passed, 10 artifacts confirmed |
| Keyboard flow (Enter→play, W accel, A steer, P pause/resume, R restart) | works, 0 errors |
| Physics probes (`teleport`/`track` hooks) | ramp → deck at y=10 ✓; ground car blocked by ramp underside at x≈186 ✓; river jump at 40 m/s lands x≈-204 ✓; 14 m/s falls in river ✓; plaza kicker 3.9 m apex ✓ |
| Headless sims (autopilot bot, seeds 3/7/9/11) | normal: dies ~47–73 s at ★2–★3 (bot never seeks repairs); god mode reaches ★5 at ~70 s heat, 2 helis, ≤11 cops, 0 errors |

GPU note: this environment only had SwiftShader/llvmpipe; FPS numbers are invalid here. Draw calls: desktop play 150–250 (garage 351), mobile 154–197; textures 62–75. Over the inspector's default budgets (300 calls / 60 textures desktop, 150/40 mobile) — tradeoff for a dense lit city; mitigations: vehicle meshes merged per material (455→243 calls), shared wheel geometry, mobile DPR 1.5, 14 traffic cars on touch devices, adaptive DPR when fps < 38.

## Tuned values
Player 44 m/s (+14 nitro), patrol 37, interceptor 46, SWAT 34 (mass 3.2), APC 31 (mass 6). Wall dmg (impact−9)×0.9, ram dmg (impact−3.5)×1.3×ramDamage×mass ratio, player per-hit cap 35, cop↔cop ×0.4. Busted: <4 m/s within 7.5 m for 2.6 s.

## Known limitations
- Real-GPU frame rate not measured here.
- Cops path on the road graph; alleys/park shortcuts are only used in direct pursuit.
- No external art/audio (procedural by necessity).
