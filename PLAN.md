# D3: World of Bits

# Game Design Vision

A world-anchored grid over Earth where you move by cells, collect and merge tokens to reach the value of 16. Deterministic token spawns so the world is reproducible.

# Technologies

- TypeScript for most game code, little to no explicit HTML, and all CSS collected in common `style.css` file
- Deno and Vite for building
- GitHub Actions + GitHub Pages for deployment automation

# Assignments

## D3.a: Core mechanics (token collection and crafting)

**Status:** complete\
**What works**

- Fixed player at classroom cell; grid rendered across the viewport.
- Deterministic cell tokens via `luck(cellKey)`.
- One held token; proximity interaction (Chebyshev radius).
- Click to pick up / place / merge equal → double.
- HUD shows held token; win at 16 (reached via merge or pickup).
- No changes to `index.html`, `_leafletWorkaround.ts`, `_luck.ts`.

## D3.b — Globe-Spanning Gameplay

movement + world consistency. Player moves one **cell** per step with **W / A / S / D**. Map recenters on the player each move.

**Step plan**

- add Cell center + recenter
- add WASD movement
- Show current `playerCell (i,j)` alongside held token and goal.
