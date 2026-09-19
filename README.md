# Jev's Fly

A colorful Three.js FPV garden game. A glowing fly swoops toward wandering goblins, and contact makes both characters pop into sparkles. The fly returns to its starting flower for the next round. [TypeSafe's Jev](https://docs.typesafe.ai/introduction) chooses its heading and dive about five times per second.

```bash
npm install
# Add TYPESAFE_API_KEY=apikey_... to .env for Jev decisions.
npm start
```

Open <http://localhost:5173>. Click **LET'S FLY** to start and enable sound. `P` pauses the game and API calls, `M` mutes, and `H` hides the HUD. `?autostart=1` starts immediately.

## FPV flight

The fly keeps the FPV style pitch, roll, yaw and throttle controller. Jev receives the goblin's bearing and angle below the horizon, then answers two typed questions: which way to turn, and whether to dive at 30°, 45°, 60°, 75° or 90°. The controller stabilizes the fly, holds a cruising height over the trees, and hovers if answers stop. The small camera view shows what the fly sees. Without an API key, the fly waits at its flower.

For a repeatable scene, use `?autostart=1&dist=90` to place a goblin about 90 m from the flower. Add `&magic=0` to turn off the goblin's sparkle spells.

## Game rules

- The goblin wanders around the garden and occasionally casts a sparkle spell when the fly comes close.
- A close swoop pops the goblin and the fly into colorful particles. Both return for another round.
- Trees, ground, depleted nectar, and spells can reset the fly.
- The HUD shows Jev's latest choices, stick positions, fly energy, nectar, goblin marker, minimap and pop count.
- Sounds are synthesized in the browser: wing buzz, wind, chimes and magical pops.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Static server and `/api/decide` proxy; keeps the API key on the server |
| `public/js/ai.js` | Jev questions, world measurements and FPV commands |
| `public/js/fly.js` | Fly model and FPV style flight controller |
| `public/js/goblin.js` | Goblin model, wandering and sparkle spells |
| `public/js/world.js` | Garden, trees, terrain and starting flower |
| `public/js/effects.js` | Sparkle and pop particles |
| `public/js/audio.js` | Synthesized game sounds |
| `public/js/hud.js` | Jev decisions, FPV display and score |
