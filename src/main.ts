// @deno-types="npm:@types/leaflet"
import leaflet from "leaflet";

import "leaflet/dist/leaflet.css";
import "./style.css";

import "./_leafletWorkaround.ts";
import luck from "./_luck.ts";

// ==============================
// Layout
// ==============================
const controlPanelDiv = document.createElement("div");
controlPanelDiv.id = "controlPanel";
controlPanelDiv.innerHTML = `
  <h2>World of Bits (D3.a)</h2>
  <p>
    Deterministic tokens on a world-wide grid.<br>
    Click nearby cells to pick up, place, and merge.
  </p>
`;
document.body.append(controlPanelDiv);

const mapDiv = document.createElement("div");
mapDiv.id = "map";
document.body.append(mapDiv);

const statusPanelDiv = document.createElement("div");
statusPanelDiv.id = "statusPanel";
document.body.append(statusPanelDiv);

// ==============================
// Config and types
// ==============================

// Classroom location (fixed)
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);

const GAMEPLAY_ZOOM_LEVEL = 19;
// Cell size (degrees). World grid anchored at (0,0).
const TILE_DEGREES = 1e-4;
const INTERACTION_RADIUS_CELLS = 3;
// Target value to "win" D3.a
const GOAL_VALUE = 32;

type CellId = { i: number; j: number };
type TokenValue = number | null;

// ==============================
// Map setup
// ==============================
const map = leaflet.map(mapDiv, {
  center: CLASSROOM_LATLNG,
  zoom: GAMEPLAY_ZOOM_LEVEL,
  minZoom: GAMEPLAY_ZOOM_LEVEL,
  maxZoom: GAMEPLAY_ZOOM_LEVEL,
  zoomControl: false,
});

leaflet
  .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
  .addTo(map);

// Layer for grid + labels
const gridLayer = leaflet.layerGroup().addTo(map);

// ==============================
// Helpers
// ==============================
function cellKey(cell: CellId): string {
  return `${cell.i},${cell.j}`;
}

function latLngToCell(lat: number, lng: number): CellId {
  return {
    i: Math.floor(lat / TILE_DEGREES),
    j: Math.floor(lng / TILE_DEGREES),
  };
}

function cellCenterLatLng(cell: CellId): leaflet.LatLng {
  const latMin = cell.i * TILE_DEGREES;
  const lngMin = cell.j * TILE_DEGREES;
  return leaflet.latLng(latMin + TILE_DEGREES / 2, lngMin + TILE_DEGREES / 2);
}

function cellToBounds(cell: CellId): leaflet.LatLngBoundsExpression {
  const latMin = cell.i * TILE_DEGREES;
  const latMax = (cell.i + 1) * TILE_DEGREES;
  const lngMin = cell.j * TILE_DEGREES;
  const lngMax = (cell.j + 1) * TILE_DEGREES;
  return [
    [latMin, lngMin],
    [latMax, lngMax],
  ];
}

function cellDistance(a: CellId, b: CellId): number {
  return Math.max(Math.abs(a.i - b.i), Math.abs(a.j - b.j));
}

// Deterministic base token using luck()
function baseTokenForCell(cell: CellId): TokenValue {
  const r = luck(`${cell.i},${cell.j},token`);

  if (r < 0.55) return null;
  if (r < 0.85) return 2;
  if (r < 0.97) return 4;
  return 8;
}

// ==============================
// State (in-memory)
// ==============================
let playerCell: CellId = latLngToCell(
  CLASSROOM_LATLNG.lat,
  CLASSROOM_LATLNG.lng,
);

let heldToken: TokenValue = null;
let goalValue = GOAL_VALUE; // One held token at a time
const modifiedCells = new Map<string, TokenValue>(); // Cells that the player has changed this session

// Player marker
const playerMarker = leaflet.circleMarker(cellCenterLatLng(playerCell), {
  radius: 6,
  weight: 2,
  color: "#ffcc00",
  fillColor: "#ffcc00",
  fillOpacity: 1,
}).addTo(map);

function recenterOnPlayer(): void {
  const center = cellCenterLatLng(playerCell);
  map.panTo(center, { animate: true });
  playerMarker.setLatLng(center);
}

// Read token for a cell (modified -> stored; otherwise base)
function getCellToken(cell: CellId): TokenValue {
  const key = cellKey(cell);
  if (modifiedCells.has(key)) {
    return modifiedCells.get(key)!;
  }
  return baseTokenForCell(cell);
}

// Write token for a cell into modified set
function setCellToken(cell: CellId, value: TokenValue): void {
  modifiedCells.set(cellKey(cell), value);
  scheduleAutosave();
}

// ==============================
// HUD + Win Check
// ==============================
function renderHUD(message: string): void {
  const held = heldToken === null ? "None" : heldToken.toString();
  const pos = `(${playerCell.i}, ${playerCell.j})`;
  statusPanelDiv.innerHTML = `
    <div><strong>Held token:</strong> ${held}</div>
    <div><strong>Goal:</strong> ${goalValue}</div>
    <div><strong>Player cell:</strong> ${pos}</div>
    <div>${message}</div>
  `;
}

// Simple HUD updater
function updateStatus(message: string): void {
  renderHUD(message);
}

// Check if a value meets the goal and, if so, announce win
function checkWinFrom(source: "hand" | "cell", value: number): void {
  if (value >= goalValue) {
    const prefix = source === "hand" ? "You forged" : "You merged into";
    renderHUD(`${prefix} ${value}! D3.a goal reached 🎉`);
  }
}

// ==============================
// Persistence — minimal save/load
// ==============================
const STORAGE_VERSION = 1;
const STORAGE_KEY = "world-of-bits:d3-save";

type SaveCell = [number, number, number | null];
type SaveBlob = {
  v: number;
  pc: [number, number];
  ht: number | null;
  g: number;
  m: SaveCell[];
};

function toSaveBlob(): SaveBlob {
  const m: SaveCell[] = [];
  for (const [k, v] of modifiedCells) {
    const [iStr, jStr] = k.split(",");
    const i = Number(iStr), j = Number(jStr);
    if (!Number.isFinite(i) || !Number.isFinite(j)) continue;
    m.push([i, j, v === null ? null : Number(v)]);
  }
  return {
    v: STORAGE_VERSION,
    pc: [playerCell.i, playerCell.j],
    ht: heldToken,
    g: goalValue,
    m,
  };
}

function applySaveBlob(s: SaveBlob): void {
  if (!s || typeof s !== "object" || s.v !== STORAGE_VERSION) return;
  if (Array.isArray(s.pc) && s.pc.length === 2) {
    const [i, j] = s.pc;
    if (Number.isFinite(i) && Number.isFinite(j)) playerCell = { i, j };
  }
  heldToken = (s.ht === null || Number.isFinite(s.ht)) ? s.ht : null;
  if (Number.isFinite(s.g)) goalValue = s.g;
  modifiedCells.clear();
  if (Array.isArray(s.m)) {
    for (const t of s.m) {
      if (!Array.isArray(t) || t.length !== 3) continue;
      const [i, j, v] = t;
      if (!Number.isFinite(i) || !Number.isFinite(j)) continue;
      modifiedCells.set(`${i},${j}`, v === null ? null : Number(v));
    }
  }
}

//function saveNow(): void {
//  try {
//    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSaveBlob()));
//    updateStatus("Game saved.");
//  } catch {
//    updateStatus("Save failed.");
//  }
//}

//function loadNow(): void {
//  try {
//    const raw = localStorage.getItem(STORAGE_KEY);
//   if (!raw) {
//      updateStatus("No saved game found.");
//      return;
//    }
//    applySaveBlob(JSON.parse(raw) as SaveBlob);
//    recenterOnPlayer();
//    redrawGrid();
//    updateStatus("Loaded saved game.");
//  } catch {
//    updateStatus("Load failed.");
//  }
//}

// Throttled autosave (avoid spamming writes to localStorage)
let autosaveTimer: number | null = null;
function scheduleAutosave(): void {
  if (autosaveTimer !== null) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSaveBlob()));
      // silent autosave; no HUD spam
    } catch { /* ignore */ }
  }, 400) as unknown as number;
}

// ==============================
// Interaction
// ==============================
function handleCellClick(cell: CellId): void {
  const dist = cellDistance(playerCell, cell);
  if (dist > INTERACTION_RADIUS_CELLS) {
    updateStatus("Too far away to interact with that cell.");
    return;
  }

  const cellValue = getCellToken(cell);

  // Case 1: hand empty → attempt pickup
  if (heldToken === null) {
    if (cellValue === null) {
      updateStatus("Nothing here to pick up.");
      return;
    }
    heldToken = cellValue;
    setCellToken(cell, null);
    updateStatus(`Picked up ${heldToken}.`);
    redrawGrid();
    if (heldToken !== null) {
      checkWinFrom("hand", heldToken);
    }
    scheduleAutosave();
    return;
  }

  // Case 2: holding token, target empty → place
  if (cellValue === null) {
    setCellToken(cell, heldToken);
    updateStatus(`Placed ${heldToken}.`);
    heldToken = null;
    redrawGrid();
    scheduleAutosave();
    return;
  }

  // Case 3: holding token, same value → merge
  if (cellValue === heldToken) {
    const newValue = cellValue * 2;
    setCellToken(cell, newValue);
    heldToken = null;
    if (newValue >= goalValue) {
      renderHUD(`Merged into ${newValue}! D3.a goal reached 🎉`);
    } else {
      updateStatus(`Merged into ${newValue}.`);
    }
    redrawGrid();
    scheduleAutosave();
    return;
  }

  // Case 4: holding token, different value → no action
  updateStatus("Cell has a different token; no merge possible.");
}

// ==============================
// Movement (W A S D)
// ==============================

function movePlayer(di: number, dj: number): void {
  playerCell = { i: playerCell.i + di, j: playerCell.j + dj };
  recenterOnPlayer();
  redrawGrid();
  updateStatus(`Moved to (${playerCell.i}, ${playerCell.j}).`);
  scheduleAutosave();
}

addEventListener("keydown", (e: KeyboardEvent) => {
  const key = e.key.toLowerCase();
  if (key === "w") {
    e.preventDefault();
    movePlayer(+1, 0);
  } else if (key === "s") {
    e.preventDefault();
    movePlayer(-1, 0);
  } else if (key === "a") {
    e.preventDefault();
    movePlayer(0, -1);
  } else if (key === "d") {
    e.preventDefault();
    movePlayer(0, +1);
  }
});

// ==============================
// Rendering
// ==============================
function redrawGrid(): void {
  gridLayer.clearLayers();

  const bounds = map.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const iMin = Math.floor(sw.lat / TILE_DEGREES) - 1;
  const iMax = Math.floor(ne.lat / TILE_DEGREES) + 1;
  const jMin = Math.floor(sw.lng / TILE_DEGREES) - 1;
  const jMax = Math.floor(ne.lng / TILE_DEGREES) + 1;

  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      const cell: CellId = { i, j };
      const value = getCellToken(cell);

      const dist = cellDistance(playerCell, cell);
      const near = dist <= INTERACTION_RADIUS_CELLS;

      const rect = leaflet.rectangle(cellToBounds(cell), {
        weight: 0.5,
        color: near ? "#00ffff" : "#888888",
        fillOpacity: value !== null ? 0.18 : 0.02,
      });

      rect.addTo(gridLayer);
      rect.on("click", () => handleCellClick(cell));

      if (value !== null) {
        const center = (rect.getBounds() as leaflet.LatLngBounds).getCenter();
        const icon = leaflet.divIcon({
          className: "token-label",
          html: `<div style="
              font-size:10px;
              font-weight:bold;
              color:${near ? "#00ffff" : "#ffffff"};
              text-shadow:0 0 3px #000;
            ">${value}</div>`,
        });
        leaflet.marker(center, { icon }).addTo(gridLayer);
      }
    }
  }
  // Keep player marker on top
  playerMarker.addTo(gridLayer);
  playerMarker.setLatLng(cellCenterLatLng(playerCell));
}

// ==============================
// Init
// ==============================
map.whenReady(() => {
  // Load save if present
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) applySaveBlob(JSON.parse(raw) as SaveBlob);
  } catch { /* ignore */ }
  recenterOnPlayer();
  updateStatus("D3.c: persistence wired (manual save/load coming next).");
  redrawGrid();
});
map.on("moveend", redrawGrid);
