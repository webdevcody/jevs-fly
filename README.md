# Jev's Fly

A colorful Three.js FPV garden game. A glowing fly swoops toward wandering goblins, and contact makes both characters pop into sparkles. The fly returns to its starting flower for the next round. [TypeSafe's Jev](https://docs.typesafe.ai/introduction) chooses its heading and dive about five times per second.

```bash
npm install
# Add TYPESAFE_API_KEY=apikey_... to .env for Jev decisions.
npm start
```

Open <http://localhost:5173>. Click **LET'S FLY** to start and enable sound. `P` pauses the game and API calls, `M` mutes, and `H` hides the HUD. The **3RD PERSON | FPV** button above the fly view, or `V`, switches the main view between the chase camera and the fly's full-screen FPV camera. The other view moves into the small window. `?autostart=1` starts immediately.

## FPV flight

The fly keeps the FPV style pitch, roll, yaw and throttle controller. Jev receives the goblin's bearing, its angle below the horizon and whether a tree or the ground blocks the line of sight to it. Trees are thin trunks under canopies that hang well above the ground, so for the path ahead it gets two things: the climb angle that keeps the fly skimming about 2 m over the ground and under the canopies, and the trunks the flight line would pass within 1.5 m of, with their distance, side and gap. Jev answers four typed questions: which way to turn, whether to sidestep a trunk, whether to climb or descend, and whether to dive at 30°, 45°, 60°, 75° or 90° along a clear line. The fly hunts low under the canopies and slips between trunks, so it can reach goblins standing under trees. The controller only stabilizes the fly, flies Jev's climb angle and sidesteps, and hovers if answers stop. The small camera view shows what the fly sees. Without an API key, the fly waits at its flower.

For a repeatable scene, use `?autostart=1&dist=90` to place a goblin about 90 m from the flower. Add `&magic=0` to turn off the goblin's sparkle spells.

## Flight logs

Every flight is recorded by `public/js/flightlog.js` and appended by the server to `.audit/flights/flights-YYYY-MM-DD.jsonl`, one flight per line. Set `FLIGHT_LOG=0` to turn this off. Each record holds:

- `path`: a sample every 0.1 s with the columns in `cols`. These are position, height above ground, speed, vertical speed, pitch, roll, heading, throttle, the clearance to the nearest tree surface (and whether that is a trunk or a canopy), and Jev's current answers.
- `decisions`: each Jev round trip, with the state it saw, its answers and the latency.
- `outcome`: how the flight ended. A tree hit records the tree, trunk or canopy, the height above the ground and up the tree, and the speed. A ground hit records the impact speed and tilt.

The last 30 flights are also on `game.flightLog.flights` in the browser console.

To fly without watching, `npm run flight-test -- --secs 120 --seed 7` runs the game in headless Chrome (needs Chrome installed; `CHROME_PATH` overrides where) and saves the flights to `.audit/flights/`. Add `--mock` to answer Jev's questions locally from their own criteria, which costs no API credits and is the way to tune the flight controller. Then `npm run flight-report -- .audit/flights/*.jsonl` prints the outcomes, how low and fast the fly flew, how close it passed trees, Jev's answer mix, and `--crash-detail` adds the path into every crash.

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
