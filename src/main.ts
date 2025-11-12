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
const GOAL_VALUE = 16;

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
// Player
// ==============================
const playerCell: CellId = latLngToCell(
  CLASSROOM_LATLNG.lat,
  CLASSROOM_LATLNG.lng,
);

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

// ==============================
// Game State
// ==============================

// Cells that the player has changed this session
const modifiedCells = new Map<string, TokenValue>();
// One held token at a time
let heldToken: TokenValue = null;

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
}

// ==============================
// HUD + Win Check
// ==============================
function renderHUD(message: string): void {
  const held = heldToken === null ? "None" : heldToken.toString();
  statusPanelDiv.innerHTML = `
    <div><strong>Held token:</strong> ${held}</div>
    <div><strong>Goal:</strong> ${GOAL_VALUE}</div>
    <div>${message}</div>
  `;
}

// Simple HUD updater
function updateStatus(message: string): void {
  renderHUD(message);
}

// Check if a value meets the goal and, if so, announce win
function checkWinFrom(source: "hand" | "cell", value: number): void {
  if (value >= GOAL_VALUE) {
    const prefix = source === "hand" ? "You forged" : "You merged into";
    renderHUD(`${prefix} ${value}! D3.a goal reached 🎉`);
  }
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
    return;
  }

  // Case 2: holding token, target empty → place
  if (cellValue === null) {
    setCellToken(cell, heldToken);
    updateStatus(`Placed ${heldToken}.`);
    heldToken = null;
    redrawGrid();
    return;
  }

  // Case 3: holding token, same value → merge
  if (cellValue === heldToken) {
    const newValue = cellValue * 2;
    setCellToken(cell, newValue);
    heldToken = null;
    if (newValue >= GOAL_VALUE) {
      updateStatus(`Merged into ${newValue}! D3.a goal reached 🎉`);
    } else {
      updateStatus(`Merged into ${newValue}.`);
    }
    redrawGrid();
    return;
  }

  // Case 4: holding token, different value → no action
  updateStatus("Cell has a different token; no merge possible.");
}

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

// Init
map.whenReady(() => {
  recenterOnPlayer();
  updateStatus("Click a nearby numbered cell to pick up a token.");
  redrawGrid();
});

map.on("moveend", redrawGrid);
