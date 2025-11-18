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
  <h2>World of Bits (D3.d)</h2>
  <p>
    Move with <strong>W/A/S/D</strong> or switch to <strong>Geolocation</strong> (Follow Me).<br>
    Click nearby cells to pick up, place, and merge.
  </p>
  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
    <label style="display:flex; gap:6px; align-items:center;">
      Mode:
      <select id="modeSelect" class="btn">
        <option value="keyboard">Keyboard</option>
        <option value="geo">Geolocation</option>
      </select>
    </label>
    <button id="btnFollow" class="btn">Follow Me: Off</button>
    <button id="btnSnapGPS" class="btn">Snap to GPS</button>
    <span id="geoStatus" style="font-size:12px; opacity:.8;"></span>
  </div>
  <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
    <button id="btnSave" class="btn">Save</button>
    <button id="btnLoad" class="btn">Load</button>
    <button id="btnNew"  class="btn">New Game</button>
  </div>
`;
document.body.append(controlPanelDiv);

const mapDiv = document.createElement("div");
mapDiv.id = "map";
document.body.append(mapDiv);

const statusPanelDiv = document.createElement("div");
statusPanelDiv.id = "statusPanel";
statusPanelDiv.textContent = "Initializing…";
document.body.append(statusPanelDiv);

// small style constants
const COLOR_NEAR = "#00ffff";
const COLOR_FAR = "#888888";
const TOKEN_LABEL_CSS =
  "font-size:10px;font-weight:bold;text-shadow:0 0 3px #000;";

// ==============================
// Config and types
// ==============================

// Classroom location
const CLASSROOM_LATLNG = leaflet.latLng(
  36.997936938057016,
  -122.05703507501151,
);
const GAMEPLAY_ZOOM_LEVEL = 19;
const TILE_DEGREES = 1e-4; // Cell size (degrees). World grid anchored at (0,0).
const INTERACTION_RADIUS_CELLS = 3;
const GOAL_VALUE = 32; // Target value to win

type CellId = { i: number; j: number };
type TokenValue = number | null;

type MovementMode = "keyboard" | "geo";

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
    attribution: "&copy; OpenStreetMap",
  })
  .addTo(map);
const gridLayer = leaflet.layerGroup().addTo(map); // Layer for grid + labels

// ==============================
// Helpers: coords & tokens
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
function baseTokenForCell(cell: CellId): TokenValue {
  const r = luck(`${cell.i},${cell.j},token`);
  if (r < 0.55) return null;
  if (r < 0.85) return 2;
  if (r < 0.97) return 4;
  return 8;
}

// ==============================
// State
// ==============================

let playerCell: CellId = latLngToCell(
  CLASSROOM_LATLNG.lat,
  CLASSROOM_LATLNG.lng,
);

let heldToken: TokenValue = null;
let goalValue = GOAL_VALUE; // One held token at a time
const modifiedCells = new Map<string, TokenValue>(); // Cells that the player has changed this session

// movement controller state
let movementMode: MovementMode = "keyboard";
let followEnabled = false;

// geolocation runtime
let geoWatchId: number | null = null;
let lastGPS: GeolocationPosition | null = null;

const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement;
const btnFollow = document.getElementById("btnFollow") as HTMLButtonElement;
const btnSnapGPS = document.getElementById("btnSnapGPS") as HTMLButtonElement;
const geoStatusSpan = document.getElementById("geoStatus") as HTMLSpanElement;

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

function setCellToken(cell: CellId, value: TokenValue): void {
  modifiedCells.set(cellKey(cell), value);
  scheduleAutosave();
}

// ==============================
// HUD + Win
// ==============================
function renderHUD(message: string): void {
  const held = heldToken === null ? "None" : heldToken.toString();
  const pos = `(${playerCell.i}, ${playerCell.j})`;

  let gpsLine = "";
  if (lastGPS) {
    const { coords } = lastGPS;
    gpsLine = `<div><strong>GPS:</strong> ${coords.latitude.toFixed(5)}, ${
      coords.longitude.toFixed(5)
    } (±${Math.round(coords.accuracy)}m)</div>`;
  }

  statusPanelDiv.innerHTML = `
    <div><strong>Held token:</strong> ${held}</div>
    <div><strong>Goal:</strong> ${goalValue}</div>
    <div><strong>Player cell:</strong> ${pos}</div>
    ${gpsLine}
    <div>${message}</div>
  `;
}

function updateStatus(message: string): void {
  renderHUD(message);
}

// Check if a value meets the goal and, if so, announce win
function checkWinFrom(source: "hand" | "cell", value: number): void {
  if (value >= goalValue) {
    const prefix = source === "hand" ? "You forged" : "You merged into";
    renderHUD(`${prefix} ${value}! goal reached 🎉`);
  }
}

// ==============================
// Persistence
// ==============================

const STORAGE_VERSION = 2;
const STORAGE_KEY = "world-of-bits:d3-save";

type SaveCell = [number, number, number | null];
type SaveBlob = {
  v: number; // version
  pc: [number, number]; // player cell
  ht: number | null; // held token
  g: number; // goal
  m: SaveCell[]; // modified cell
  mode?: MovementMode; // "keyboard" | "geo"
  follow?: boolean; // follow flag
  gps?: { lat: number; lng: number; acc: number } | null;
};

const MAX_CELLS_TO_STORE = 10000;

function toSaveBlob(): SaveBlob {
  const m: SaveCell[] = [];
  for (const [k, v] of modifiedCells) {
    if (m.length >= MAX_CELLS_TO_STORE) break;
    const [iStr, jStr] = k.split(",");
    const i = Number(iStr);
    const j = Number(jStr);
    if (!Number.isFinite(i) || !Number.isFinite(j)) continue;
    m.push([i, j, v === null ? null : Number(v)]);
  }

  const gps = lastGPS
    ? {
      lat: lastGPS.coords.latitude,
      lng: lastGPS.coords.longitude,
      acc: lastGPS.coords.accuracy,
    }
    : null;

  return {
    v: STORAGE_VERSION,
    pc: [playerCell.i, playerCell.j],
    ht: heldToken,
    g: goalValue,
    m,
    mode: movementMode,
    follow: followEnabled,
    gps,
  };
}

function applySaveBlob(s: SaveBlob): void {
  if (!s || typeof s !== "object" || typeof s.v !== "number") return;
  if (s.v < 1) return;
  if (
    Array.isArray(s.pc) && s.pc.length === 2 && Number.isFinite(s.pc[0]) &&
    Number.isFinite(s.pc[1])
  ) {
    playerCell = { i: s.pc[0], j: s.pc[1] };
  }
  // held
  heldToken = s.ht === null || Number.isFinite(s.ht)
    ? (s.ht as number | null)
    : null;
  // goal
  if (Number.isFinite(s.g)) goalValue = s.g;

  modifiedCells.clear();
  if (Array.isArray(s.m)) {
    for (const t of s.m) {
      if (!Array.isArray(t) || t.length !== 3) continue;
      const [i, j, v] = t;
      if (!Number.isFinite(i) || !Number.isFinite(j)) continue;
      const val: TokenValue = v === null ? null : Number(v);
      modifiedCells.set(`${i},${j}`, val);
      if (modifiedCells.size >= MAX_CELLS_TO_STORE) break;
    }
  }
}

function saveNow(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSaveBlob()));
    updateStatus("Game saved.");
  } catch {
    updateStatus("Save failed.");
  }
}

function loadNow(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      updateStatus("No saved game found.");
      return;
    }
    applySaveBlob(JSON.parse(raw) as SaveBlob);

    // reflect controller UI
    modeSelect.value = movementMode;
    setFollowUI(followEnabled);

    // map/UI update
    recenterOnPlayer();
    redrawGrid();
    updateStatus("Loaded saved game.");

    // if follow was on, try to resume GPS
    if (movementMode === "geo" && followEnabled) startGeoWatch();
  } catch {
    updateStatus("Load failed.");
  }
}
function clearSave(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

// Throttled autosave (avoid spamming writes to localStorage)
let autosaveTimer: number | null = null;
function scheduleAutosave(): void {
  if (autosaveTimer !== null) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSaveBlob()));
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
    updateStatus(`Merged into ${newValue}.`);
    checkWinFrom("cell", newValue);
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

// ---- Geolocation controller ----

function setFollowUI(on: boolean): void {
  btnFollow.textContent = `Follow Me: ${on ? "On" : "Off"}`;
}

function updateGeoStatus(txt: string): void {
  geoStatusSpan.textContent = txt;
}

function startGeoWatch(): void {
  if (!navigator.geolocation) {
    updateGeoStatus("Geolocation unsupported.");
    followEnabled = false;
    return;
  }
  if (geoWatchId !== null) return; // already watching
  try {
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        lastGPS = pos;
        const { latitude, longitude } = pos.coords;
        const nextCell = latLngToCell(latitude, longitude);
        // Only move when the cell changes
        if (nextCell.i !== playerCell.i || nextCell.j !== playerCell.j) {
          playerCell = nextCell;
          recenterOnPlayer();
          redrawGrid();
          const acc = Math.round(pos.coords.accuracy);
          updateStatus(
            `GPS move → (${playerCell.i}, ${playerCell.j}). (±${
              Math.round(acc)
            }m)`,
          );
          scheduleAutosave();
        } else {
          renderHUD("Following GPS…");
        }
        updateGeoStatus("GPS: tracking");
      },
      (err) => {
        updateGeoStatus(`GPS error: ${err.message}`);
        followEnabled = false;
        setFollowUI(false);
        if (movementMode === "geo") {
          // keep mode but not following; user can try Snap or turn follow back on
        }
        stopGeoWatch();
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
    );
    updateGeoStatus("GPS: starting…");
    // deno-lint-ignore no-unused-vars
  } catch (e) {
    updateGeoStatus("GPS start failed.");
    followEnabled = false;
    setFollowUI(false);
  }
}

function stopGeoWatch(): void {
  if (geoWatchId !== null) {
    try {
      navigator.geolocation.clearWatch(geoWatchId);
    } catch { /* ignore */ }
    geoWatchId = null;
  }
  updateGeoStatus("GPS: idle");
}

function snapToGPS(): void {
  if (!navigator.geolocation) {
    updateGeoStatus("Geolocation unsupported.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastGPS = pos;
      const { latitude, longitude, accuracy } = pos.coords;
      const nextCell = latLngToCell(latitude, longitude);
      playerCell = nextCell;
      recenterOnPlayer();
      redrawGrid();
      updateStatus(
        `Snapped to GPS → (${playerCell.i}, ${playerCell.j}). (±${
          Math.round(accuracy)
        }m)`,
      );
      scheduleAutosave();
      updateGeoStatus("GPS: snapped");
    },
    (err) => {
      updateGeoStatus(`GPS snap error: ${err.message}`);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 },
  );
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
        color: near ? COLOR_NEAR : COLOR_FAR,
        fillOpacity: value !== null ? 0.18 : 0.02,
      });

      rect.addTo(gridLayer);
      rect.on("click", () => handleCellClick(cell));

      if (value !== null) {
        const center = (rect.getBounds() as leaflet.LatLngBounds).getCenter();
        const icon = leaflet.divIcon({
          className: "token-label",
          html: `<div style="${TOKEN_LABEL_CSS}
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
// Init + Buttons
// ==============================

function newGame(): void {
  playerCell = latLngToCell(CLASSROOM_LATLNG.lat, CLASSROOM_LATLNG.lng);
  heldToken = null;
  goalValue = GOAL_VALUE;
  modifiedCells.clear();
  movementMode = "keyboard";
  followEnabled = false;

  stopGeoWatch();
  setFollowUI(false);
  modeSelect.value = "keyboard";

  clearSave();
  recenterOnPlayer();
  redrawGrid();
  updateStatus("New game started.");
}

function wireButtons(): void {
  // Mode select
  modeSelect.addEventListener("change", () => {
    movementMode = modeSelect.value as MovementMode;
    if (movementMode === "geo") {
      updateStatus(
        "Geolocation mode selected. Click Follow Me to start/stop tracking.",
      );
    } else {
      // keyboard
      stopGeoWatch();
      followEnabled = false;
      setFollowUI(false);
      updateStatus("Keyboard mode selected (W/A/S/D).");
    }
    scheduleAutosave();
  });

  // Follow Me toggle: starts/stops the live GPS watch
  btnFollow.addEventListener("click", () => {
    if (movementMode !== "geo") {
      movementMode = "geo";
      modeSelect.value = "geo";
    }
    followEnabled = !followEnabled;
    setFollowUI(followEnabled);
    if (followEnabled) startGeoWatch();
    else stopGeoWatch();
    scheduleAutosave();
  });

  // Snap once
  btnSnapGPS.addEventListener("click", () => {
    snapToGPS();
  });

  // Save/Load/New
  document.getElementById("btnSave")?.addEventListener(
    "click",
    () => saveNow(),
  );
  document.getElementById("btnLoad")?.addEventListener(
    "click",
    () => loadNow(),
  );
  document.getElementById("btnNew")?.addEventListener("click", () => newGame());
}

map.whenReady(() => {
  // Load save if present
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) applySaveBlob(JSON.parse(raw) as SaveBlob);
  } catch { /* ignore */ }

  modeSelect.value = movementMode;
  setFollowUI(followEnabled);

  if (movementMode === "geo" && followEnabled) startGeoWatch();

  recenterOnPlayer();
  wireButtons();
  updateStatus(
    movementMode === "geo"
      ? "Geolocation mode. Click Follow Me to start tracking."
      : "Keyboard mode. Use W/A/S/D to move.",
  );
  redrawGrid();
});
