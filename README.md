# AeroBoard

Top-down airplane boarding simulation (30 rows, single aisle, 3–3 layout). Runs entirely in the browser as static files—no build step.

*Kurz: GitHub-Pages-taugliche Boarding-Websimulation; UI-Texte teils Deutsch.*

**Live demo:** [AeroBoard on GitHub Pages](https://makemepaul.github.io/PlaneSeatOptimisation/)

### Simulation (GIF)

[![AeroBoard boarding simulation](docs/simulation-demo.gif)](https://makemepaul.github.io/PlaneSeatOptimisation/)

The GIF lives at [`docs/simulation-demo.gif`](docs/simulation-demo.gif).

---

## Architecture

- **Static frontend:** `index.html`, `style.css`, `app.js`, and `algorithms.js` are enough to run the app. Deploy from the repository root to **GitHub Pages** (or any static host).
- **No required backend:** You do not need Python or a server process for the simulation.
- **`backend/main.py`:** Placeholder only (`healthcheck()`). A future FastAPI service is not implemented yet; do not expect REST APIs from this file today.

## Automated tests

Vitest + happy-dom run correctness checks against the same `algorithms.js` and `app.js` the site uses (see [`tests/setup.js`](tests/setup.js)). **Running the demo in a browser still requires no Node or build step.** GitHub Pages deployment stays a static root (`index.html` and assets only); `package.json` and `tests/` are for contributors who want automated checks.

```bash
npm install
npm test
npm run test:watch   # optional, re-runs on file changes
```

Simulation tests use `basePassengerSet` so blueprint generation does not depend on UI checkbox state. `app.js` exposes `globalThis.__AeroBoardTestExports` (frozen) for `Simulation`, `Plane`, `buildBoardingPreviewPlanFromUi`, and small RNG helpers—intended for tests only.

**What the suite checks:** single-passenger completion; walking blocked behind occupied aisle cells; stowing at the door with a non-empty queue; seating keeps the passenger in the aisle; finished runs have empty queue/aisle and correct seat count; every `BoardingAlgorithms.*.run` returns a full permutation; `exactAStar` warns and falls back beyond nine passengers; `boundedAStar` permutes 120 passengers; `prototypeCluster` ignores misleading `clusterId` in favor of row bands.

**Not covered:** canvas/UI flows, optimality of random or tick search, exact A* cost optimality, or deterministic interference tick counts (RNG-driven).

---

## Feature status

### Implemented

- Boarding simulation with canvas rendering, single-plane geometry (30 rows, one aisle).
- Passenger state chain: `waiting` → `walking` → `stowing` → `seating` (if needed) → `seated`.
- Seat occupancy on `Plane.seats[row][letter]`; aisle occupancy; statistics (including seated count).
- **Simplified seat interference:** aisle passengers who must pass occupied window/middle seats incur extra delay ticks per blocking seat, drawn from a fixed integer range (see Limitations).
- Profiles (`business`, `standard`, `elderly`, `child`, `heavy_luggage`) affecting `stowTime`, `moveCooldown`, and tooltips; optional **benchmark mode** (fixed standard timings).
- **Seeds:** blueprint RNG (seats, profiles, stow samples) vs per-run simulation RNG mixed with algorithm key; UI seed, “new seed”, active seed display.
- **Comparison mode:** multiple algorithms, shared passenger blueprints, cloned runs, results table (numeric columns right-aligned; best average queue delay lightly highlighted when all runs finished).
- **Batch comparison:** many runs without canvas, optional CSV export to clipboard; win rates and tick aggregates are **observed** only. Table is **sorted by mean ticks** (ascending, best first) with tie-breakers (win rate, std dev, name); the best row is highlighted; column headers can re-sort; CSV row order matches the sorted table when export runs after completed batches. **KPI summary cards** (best algorithm, mean ticks, best normal/optimized, lowest mean wait) and a toggle to show **advanced metric columns** (min/max/wins and mean stow/seat/walk/spawn/aisle).
- **Algorithm preview (“Algorithmus-Vorschau”):** boarding-order strip with **phase/group boundaries**, **rank heatmap** seat grid (darker = earlier boarding; optional small order/cluster label), tooltips (id, rank, seat, profile, cluster), plain-language **algorithm explanation** box, and phase legend—built from the same `Simulation` boarding queue snapshot as the live single run (no extra animation).
- **Responsive UI:** two-column layout on desktop (**narrow sticky sidebar** with **mode switch**: single / comparison / batch; **Advanced** `<details>` for seed, profiles, benchmark), **sim canvas + algorithm preview side-by-side**, **tabbed results** (comparison table, batch + KPIs, metrics glossary + finished-comparison detail table), compact spacing, capped canvas height, scrollable results with sticky table headers.
- All boarding algorithms listed under [Boarding algorithms](#boarding-algorithms) (including Steffen and row-bin interleave).

### Partial

- **`groupId` / groups:** `groupPassengersForBoarding` in `algorithms.js` keeps declared groups contiguous in ordering. Default blueprints still use `groupId: null` everywhere—there is no separate “family generator” or rich family boarding policy.
- **Tick Search:** heavily depends on the app-injected runner in `app.js` (`window.__aeroBoardRunTickSearch`). The stub in `algorithms.js` alone falls back to bounded A* if that hook is missing.

### Planned

- FastAPI (or similar) backend in `backend/main.py` for remote simulation/optimization APIs.
- Richer family rules, external optimizers, and calibration beyond this prototype (see Roadmap).

---

## Project layout

| Path | Role |
|------|------|
| `index.html` | Page structure and controls |
| `style.css` | Layout and styling |
| `app.js` | Passengers, plane, simulation loop, UI, registry validation, tick-search runner |
| `algorithms.js` | `window.BoardingAlgorithms` — boarding `run()` implementations |
| `docs/` | Media only here (e.g. `simulation-demo.gif`); no separate docs site |
| `backend/main.py` | Placeholder for a future backend |

---

## Local run

Use any static file server from the repo root (opening `file://` may block modules or behave inconsistently):

**Python**

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`.

**Node (optional)**

```bash
npx --yes serve -l 8000
```

---

## Tests and QA

There is **no** automated unit or browser test suite in this repository yet.

**Manual smoke test** (before a demo or release):

1. Serve the repo root over HTTP (see [Local run](#local-run)); open the app in the browser.
2. **Single simulation:** Start, Pause, step one tick (Ein Tick), Reset; switch algorithm and passenger count and confirm stats and canvas update.
3. **Comparison mode:** select at least two algorithms, start; confirm the results table updates; when all runs finish, every algorithm tied on the **lowest** tick count is highlighted as a winner (same spirit as batch tie-breaking).
4. **Batch comparison:** run a small number of batch runs (e.g. 3), confirm progress text and the batch statistics table; use **Batch CSV** and confirm exported columns match the on-screen batch table (including mean walk blocks and max aisle occupancy).
5. **Seeds:** set a seed, reset the single simulation twice and confirm an identical passenger layout; change the seed and confirm the layout changes.

**Optional debug logging:** append `?aeroboardDebug=1` to the URL to log loaded algorithm keys and a profile-count table whenever passenger blueprints are built.

---

## GitHub Pages deployment

1. Push this repository to GitHub.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose your default branch (e.g. `main`), and folder **`/` (root)**.
4. Save and wait for the published URL (GitHub shows it on the same page).

No build or GitHub Actions workflow is required. If you fork the repo, enable Pages on your fork and use your fork’s URL for the demo link.

---

## Boarding algorithms

Implementations live in [`algorithms.js`](algorithms.js). Each registry entry uses `type: "normal"` or `"optimized"` (controls which list the UI shows). Unless noted, ordering is **group-aware**: passengers with the same `groupId` stay together as a block; passengers without `groupId` are treated as singleton groups.

### Random (`random`)

Shuffles **groups** (Fisher–Yates with `options.rng`), then concatenates. Uses `options.rng`.

### Back-to-front (`backToFront`)

Shuffles the list of **groups** with `options.rng`, then sorts groups by **`maxTargetRow` descending** (higher row numbers first), then flattens. With default blueprints each passenger is usually a **singleton group**, so you get **back-to-front by row**, but **within the same row** the relative order is still whatever the shuffle produced (stochastic). Uses `options.rng`.

### Window–middle–aisle, zoned (`windowMiddleAisle`)

**Zones by row:** rear (rows 21–30), then middle (11–20), then front (1–10). Within a zone: **window (A/F) → middle (B/E) → aisle (C/D)** via each group’s best seat type, then back-to-front by `maxTargetRow`, then stable ties. **Deterministic** (no RNG inside this algorithm).

### Steffen, deterministic (`steffenDeterministic`)

A **fixed Steffen-style priority** over groups: window/middle/aisle, odd row before even within type, then back-to-front by row, then seat tie-breakers and ids. **Fully deterministic** for a given passenger set. This is an approximation of published Steffen methods, not a proof-carrying reproduction of a specific paper.

### Prototype cluster (`prototypeCluster`)

Groups are assigned to row bands (`cluster_1` … `cluster_4` from target row), then sorted so **rear bands board before front** (e.g. cluster_4 before cluster_1), with row and id tie-breaks. Deterministic; does not read a pre-set `clusterId` from blueprints.

### Heuristic cluster (`heuristicCluster`)

**Optimized (UI category):** scores each group with a weighted mix of average row, seat type, stow time, profile penalties, and size, then orders groups by that heuristic score. Optimizes a **hand-tuned surrogate**, not measured simulation ticks.

### Row-bin interleave (`rowBinInterleave`)

**Normal procedure:** passengers are grouped into **6-row bins** (rows 1–6, 7–12, …). Within each bin, sort by row then id. Final order **round-robins** across bins (first passenger from each bin in bin index order, then second from each, etc.). Useful for spreading rows without full randomness. Cluster colors in the UI use the same row-band `cluster_1`…`cluster_4` mapping as prototype/heuristic cluster.

### Exact A* (cost model) (`exactAStar`)

**Optimized:** best-first search over **complete boarding permutations** using an internal weighted **transition cost** and heuristic (`g` + `h`). Only for **at most 9 passengers**; above that, the code **falls back to bounded A\*** and logs a warning. **“Exact” means optimal for this abstract cost model only**—not guaranteed minimum **real** ticks from the main simulator. The UI label switches to **“Exact A* (cost model) → Bounded A* (cost model)”** when that fallback applies.

### Bounded A* (cost model) (`boundedAStar`)

**Optimized:** same cost idea as exact A*, but with expansion budget, branching cap, open-set size cap, and a **deterministic tail** when the budget is exhausted. **Approximate**; not full enumeration.

### Tick search (sampled) (`tickSearch`)

**Optimized:** in the full app, `app.js` registers `window.__aeroBoardRunTickSearch`, which:

1. Builds a baseline order (shuffled ids, optionally seeded from **bounded A\*** queue order).
2. Evaluates **many random permutations** plus **random pairwise swaps** on the best-so-far, each time running a **full mini-simulation** with the same physics as the main sim.
3. Returns the passenger order with the **lowest observed tick count among those candidates**.

Trial counts scale with passenger count (roughly tens of random trials and tens to hundreds of swap attempts—not exhaustive over all permutations). **Heavily CPU-intensive.** Picks the best **sampled** order, not a globally optimal one.

---

## Limitations

- **Toy geometry:** single aisle, 3–3, 30 rows—not a specific aircraft type.
- **Simplified interference:** blocking map per seat letter (e.g. A blocked by B/C if occupied); each blocking seat adds a random delay in **[3, 8] ticks** per blocker, using the simulation RNG—not calibrated to real cabin data.
- **Cost-model algorithms** (`heuristicCluster`, `exactAStar`, `boundedAStar`) minimize or search a **surrogate graph cost**, not the final tick counter. They are **not** certificates of minimal boarding time.
- **Tick search** only sees its **candidate set**; a better order may exist outside the search.
- **Comparison tables** report **observed ticks** for one shared blueprint (or one per batch index)—not global optima over all orders.
- **Optimized methods can lose to random on a single run:** structured orders can cluster stows in the aisle; **random** spreads congestion and, together with interference variance, sometimes wins—especially in a simplified model.
- **One run is one draw:** interference and random boarding paths add variance. Prefer **batch mode** or many manual re-runs when comparing algorithms.

---

## Reproducibility

- **UI seed:** default `12345`; “new seed” picks a random 32-bit value. Display shows the **active** seed used for the next blueprint build.
- **Blueprint RNG (`createSeededRng`):** derived from the blueprint seed. Drives seat assignment shuffle, profile rolls (if enabled), stow-time sampling, etc. Same seed + same options → same passenger **blueprints**.
- **Simulation RNG:** `mixSimulationSeed(blueprintSeed, algorithmKey)` gives each algorithm its own stream for boarding randomness (`random`, `backToFront` group shuffle), tick-search sampling, seat-interference draws, etc. `Math.random` is **not** used for this logic.
- **Comparison mode:** one blueprint seed; all algorithms share the same base passengers; each simulation still has its own mixed RNG.
- **Batch mode:** run `i` (0-based) uses `blueprintSeed = (parseSeed(UI) + i) >>> 0`. Same UI seed and batch count → reproducible batch.

**Why multiple runs matter:** a single comparison is one realization of interference and random tie-breaking. **Batch comparison** aggregates win rates and tick stats over many seeds so rankings are less dominated by noise.

---

## Comparison mode and fairness

- The UI splits **normal** vs **optimized** procedures (optimized note in the UI: cost models vs observed ticks).
- **Single run:** one algorithm, start/pause/step/reset.
- **Comparison:** select algorithms with checkboxes, one shared start; `basePassengerSet` is built once and **cloned** per algorithm.
- Each clone gets its own `Plane`, queue, tick counter, and finish flag, but identical blueprint fields (`id`, `targetSeat`, profile, stow, cooldown, `groupId`).
- When every comparison run has finished, **all** algorithms tied on the lowest tick count are highlighted in the table (not only the first row after sorting).
- Ties in batch wins: **all** tied lowest-tick algorithms get a win for that run.

---

## Batch comparison (statistics)

- Uses the same algorithm checkboxes as simple comparison; runs **without** canvas rendering, chunked with `setTimeout` to avoid freezing the tab.
- Per run index `i`: `blueprintSeed = (UI seed + i) >>> 0`; per algorithm, full tick simulation with `mixSimulationSeed(blueprintSeed, algorithmKey)`.
- **Win rate** = wins divided by **completed** runs (cancelled runs drop incomplete data).
- Averages/min/max are **empirical**; not optimality guarantees.
- The batch statistics table columns match the **Batch CSV** export (mean stow/seat/walking-block/spawn-block ticks, max aisle occupancy, average queue delay).
- **Tick search** inside a batch can make individual runs very slow.

---

## Cluster colors (UI)

Algorithm-dependent `clusterId` drives deterministic colors (not an optimization output):

| Algorithm | Cluster ids (conceptual) |
|-----------|---------------------------|
| `random` | `random` |
| `backToFront` | `zone_back` / `zone_middle` / `zone_front` by row |
| `windowMiddleAisle` | `window` / `middle` / `aisle` by seat letter |
| `steffenDeterministic` | `steffen_window_odd`, `steffen_window_even`, … |
| `prototypeCluster`, `heuristicCluster`, `rowBinInterleave` | `cluster_1` (rows 1–8) … `cluster_4` (25–30) |
| `exactAStar`, `boundedAStar`, `tickSearch` | `astar_1` … `astar_4` by position quartiles in final order |

Invalid entries in `BoardingAlgorithms` are skipped at load time; if **no** valid algorithms remain, the app shows a boot error. If a **selected** algorithm key is missing or `run` throws, `orderPassengers` falls back to **`random`** (with console warnings). Invalid entities in the returned array are filtered out with a warning.

---

## Passenger profiles

- Keys: `business`, `standard`, `elderly`, `child`, `heavy_luggage`.
- **Enable profiles** (default on) and **benchmark mode** (fixed standard passenger timings for fairer algorithm-only comparisons) are UI toggles.

---

## How to add a new algorithm

1. **Register** in [`algorithms.js`](algorithms.js) on `window.BoardingAlgorithms` with an object shaped as:

   ```js
   myAlgorithm: {
     key: "myAlgorithm",       // unique string, same as property name recommended
     label: "My Algorithm",  // shown in UI
     type: "normal",         // or "optimized"
     run(passengers, options) { ... },
   },
   ```

2. **`run(passengers, options)`** must return an **array containing each input passenger exactly once** (typically a reordering of the same object references). Do not drop or duplicate passengers.

3. **Mutations:** avoid changing passenger fields unless intentional. After ordering, `app.js` assigns **`clusterId` / colors** for visualization via `assignClustersForAlgorithm` for known keys; for unknown keys, coloring falls back to `random`. If you need custom colors, extend `clusterIdForAlgorithm` in `app.js` (that would be a code change beyond docs).

4. **`options`:** several algorithms require `options.rng` with a `.next()` method returning numbers in [0, 1). Match existing algorithms (`random`, `backToFront`, `tickSearch`).

5. **Legacy shape:** `getAlgorithmRegistry()` in `app.js` still accepts a **function** per key for a fixed allowlist (`random`, `backToFront`, …). New entries should use the **object shape** above so you do **not** need allowlist edits.

---

## Roadmap (not implemented here)

- Family / group boarding rules beyond contiguous sort order.
- Richer seat interference and calibration to data.
- Heavier clustering or external optimizers.
- Real FastAPI service in `backend/main.py` for simulation and optimization APIs.
