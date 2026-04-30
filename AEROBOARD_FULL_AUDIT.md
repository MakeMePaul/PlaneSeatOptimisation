# AeroBoard Full Project Audit

Structured senior-engineering audit (simulation, algorithms, UI, architecture). **Scope:** `index.html`, `style.css`, `app.js`, `algorithms.js`, `README.md`, `backend/main.py`. No code was modified for this document.

---

## Executive Summary

- **Overall completion:** ~42%
- **Main strengths:** Clear separation between simulation core (`Simulation`, `Plane`, `Passenger`) and rendering (`Renderer`); static, no-build GitHub Pages layout; explicit boarding queue contract (`algorithm.run(passengers) → array`); comparison mode clones from one blueprint set; seat occupancy + aisle occupancy modeled; documented passenger profiles and benchmark toggle.
- **Main weaknesses:** “Optimized” algorithms optimize abstract weighted costs, not measured simulation ticks; `prototypeCluster` effectively broken relative to its documented intent (cluster IDs assigned too late); no RNG seeding → irreproducible comparisons; groups/families not generated—`groupId` always `null` in blueprints; no separate input/queue modes (single pipeline only); metrics omit aisle-blocking/stow variance diagnostics.
- **Biggest current risk:** Treating **Exact A\*** / **Bounded A\*** results as scientific optimization of boarding time without validating cost-to-ticks alignment misleads users and invalidates cross-algorithm claims.
- **Best next step:** Define an explicit **evaluation contract** (same RNG seed, same cost function as ticks or calibrate weights), fix cluster assignment order for `prototypeCluster` (or compute clusters from row before sort), add reproducibility for comparison mode.

---

## Completion Estimate

| Category | Percent | Reason |
|----------|---------|--------|
| Prototype completeness | 55% | End-to-end single + comparison sim, multiple algorithms, canvas, tooltips, README; missing robust eval harness and family/group generation. |
| Simulation realism | 35% | Single-file aisle, discrete ticks, one stow column per row position, simplified seat interference (random adds per blocker); no row shuffle, no dual aisle, no overtaking rules beyond movement order. |
| Algorithm quality | 40% | Queue heuristics vary in sophistication; A* is structurally search-based but optimizes hand-tuned weights, not ticks; `prototypeCluster` logic diverges from documented clusters. |
| UI/UX quality | 60% | Controls are clear (German copy); legend explains fill vs stroke; fixed canvas can crowd small screens; comparison table functional; “waiting” not visualized on canvas. |
| Architecture quality | 55% | Modular registry and cloning for comparison; heavy reliance on `window` globals and UI coupled to `createPassengerBlueprints`; algorithm registry allowlist + legacy shape supported. |
| Readiness for GitHub Pages | 90% | Static files, relative paths, script order `algorithms.js` then `app.js`; no backend required for frontend. |
| Readiness for future Python backend | 30% | Placeholder `healthcheck` only; no API schema or serialization boundary yet—easy to add later if payloads mirror `Passenger` + queue + tick API. |
| Readiness for serious algorithm comparison | 25% | Same blueprints help fairness; random unseeded; objective function for “optimized” ≠ simulator output; no statistics across runs. |

**Overall percentage complete (weighted toward stated long-term goal):** **~42%**

---

## Critical Findings

1. **`prototypeCluster` uses `passenger.clusterId` during `orderPassengers()` before `assignClustersForAlgorithm()` runs** — blueprints/clones use `"random"` until assignment after ordering; sort falls back to row tie-break, not row-band clusters (`cluster_1`…`cluster_4`) as documented.
2. **A\* (`exactAStar` / `boundedAStar`) minimizes `g`/`h` built from weighted penalties** — not integrated with the discrete-event simulator; **no guarantee** of minimal ticks or even correlation without calibration.
3. **No RNG seeding** — `random`, Fisher–Yates shuffles, seat interference draws, and profile rolls differ every run; comparison winner is **single-sample stochastic**.
4. **Families/groups** — `createPassengerBlueprints` sets `groupId: null` always; `groupPassengersForBoarding` gives each passenger a unique synthetic key → **no real groups** unless manually injected into blueprints.
5. **`astarOptimized` referenced in `app.js` allowlist** but **not exported** in `algorithms.js` — dead legacy hook.
6. **README claims “Seat-Interference (z. B. Blockieren auf Fenster-/Mittelsitzen)” under Roadmap** while basic interference already exists — documentation drift.

---

## Detailed Audit

### 1. Overall project completion

See **Completion Estimate** table and **Executive Summary**. The codebase is a credible **interactive prototype** for demonstrations; it is **not** yet a validated research instrument for optimization.

### 2. Simulation correctness

**State machine (implemented):** `waiting` → `walking` → `stowing` → (`seating` if interference) → `seated`. Implemented in `Simulation` (`updateStowing`, `moveWalkingPassengers`, `spawnPassenger`, `completeSeatingFromAisle`).

| Check | Assessment |
|-------|------------|
| Passengers enter aisle correctly | First free slot is row 1 (`aisle[0]`); spawn only if `isAisleFree(0)`. |
| One passenger per aisle cell | `Plane.aisle` stores one reference per index; move clears source slot. |
| Collision / passing | `moveWalkingPassengers` iterates **back to front**; move only if `nextPos` free—no overtaking through occupied cells. |
| Stowing blocks aisle | Passenger remains in aisle slot in `stowing` (and `seating`). |
| Seating blocks aisle | Yes—still in aisle until `seatPassenger` succeeds. |
| Correct seat assignment | `seatPassenger` uses `targetSeat`; duplicate seat prevented if map consistent. |
| Aisle freed after seating | `setAisle(position, null)` on success. |
| Disappear / duplicate | Normal paths preserve references; invalid aisle entities removed with warning. Algorithm returning duplicate objects could theoretically duplicate queue entries (not seen in bundled algorithms). |
| Simulation ends | `isFinished()` when `waiting === 0 && aisle === 0`. |
| Tick count | Incremented once per `tick()` at start—reliable for that definition. |
| Reset | `SingleSimulationController.reset()` rebuilds `Simulation` + `Renderer`; comparison reset clears `basePassengerSet`. |

**Edge risk:** If `seatPassenger` fails after interference, code sets `remainingSeatInterferenceTime = 1` and retries—in a pathological double-booking scenario, simulation could stall (unlikely with unique seats from blueprints).

### 3. Seat model and seat interference

- **Occupancy:** `Plane.seats[row][letter]`; `isSeatOccupied`, `seatPassenger`, `getOccupiedSeatsCount` implemented in `app.js`.
- **Blocking map:** A←B,C; B←C; C empty; D empty; E←D; F←E,D — matches the requested pattern.
- **Timing:** For each blocking occupied seat, adds `randomIntInclusive(3, 8)` — independent RNG per blocker, not passenger-specific behavior; **high variance** run-to-run.
- **Effect on algorithms:** Any ordering can be reshuffled by interference noise—**meaningful ranking needs multiple seeds or deterministic interference**.
- **Balance:** Interference can dominate stow for window seats when B/C already seated—**realistic directionally**; magnitude is arbitrary without calibration.

### 4. Aisle interference

- Movement one row per cooldown tick when ahead cell free; **back-to-front update** reduces artificial overtaking.
- **Stow time** + **profiles** create bottlenecks in the aisle (passengers occupy aisle during stow/seat interference).
- **Random boarding** can outperform structured methods when structured orders **cluster stows** in the same aisle segment (documented phenomenon in simplified models).
- **Metrics:** Only counts (`waiting`, aisle occupancy, seated)—no dedicated “blocked ticks” or “aisle standing time” metric.

### 5. Passenger profiles

- **Checkbox:** `enableProfilesCheckbox`; when off, all passengers use **standard** profile for label/ranges but **stowTime** still drawn from standard range `[6, 14]` unless benchmark mode.
- **Benchmark mode:** Forces profile `standard`, `stowTime = 10`, `moveCooldown = 0` — **isolates algorithm order** better than “profiles off.”
- **Tooltips:** Show profile and remaining times — good visibility.
- **Extensibility:** `PASSENGER_PROFILES` map is a clean extension point.

### 6. Groups and families

- **Generation:** Only explicit `groupId` on blueprints—**none** created by default.
- **`groupPassengersForBoarding`:** Works mechanically; without real groups, each passenger is its own “group” (`single:N`).
- **Algorithms:** Sorting operates on groups where defined—**A\* ignores group contiguity** (permutation of individuals).
- **Documentation:** README states group-aware preparation — **partially true** (structure exists; data does not).
- **Future / risks:** Mixed rows in one group would require boarding rules not implemented; current sorts could separate members across queue unless explicitly constrained.

### 7. Boarding algorithms

| Algorithm | Role | Notes |
|-----------|------|--------|
| `random` | Shuffle group order then flatten | Stochastic; fair only across many seeds. |
| `backToFront` | Groups sorted by `maxTargetRow` desc | Initial `randomOrder` of groups is **nullified** when every group is size 1 (typical)—final order is **deterministic** back-to-front by row. |
| `windowMiddleAisle` | Zoned WMA: rear/mid/front then window/middle/aisle, then row | **Zoned**, deterministic tie-break; group-aware if multi-seat groups exist. |
| `prototypeCluster` | Intended cluster priority | **Broken** vs intent — see Critical Findings. |
| `heuristicCluster` | Weighted group scoring | Does not depend on pre-assigned `clusterId`; internally consistent. |
| `exactAStar` | Full open-set A* for N≤9 | Expands all candidates per node (no branching cap); costs abstract. |
| `boundedAStar` | Budget + candidate cap + open-set trim + tail | Beam-like / bounded best-first; **not** exact optimality for abstract cost, let alone ticks. |
| `astarOptimized` | — | **Not present** in registry export; allowlist only in `app.js`. |

### 8. Window–Middle–Aisle specifically

- **Zoned** (`zonePriorityForRow`: rear 21–30, middle 11–20, front 1–10).
- Within zone: **window → middle → aisle** via `groupSeatTypePriority` (best seat type in group).
- **Back-to-front** among ties via `maxTargetRow` and stable group compare.
- **Deterministic** given fixed inputs (no RNG inside WMA).
- **Group-aware** only if `groupId` shared.
- **Aisle clusters** still likely when many same-zone aisle seats load together.

**Why random can beat WMA here:** Stochastic spacing can **spread stow congestion** along the aisle; WMA can schedule correlated seat types in sequence, increasing localized blocking. Noise from interference and stow variance amplifies single-run outcomes.

### 9. A\* / search algorithm audit

**Verdict:** **`exactAStar` implements A\*** (priority ordering by `f = g + h`, pruning dominated `g` per abstract state key `(remaining set, last passenger)`), with **full branching** over remaining passengers for **N ≤ 9**. It is **not** optimizing simulation ticks.

**`boundedAStar`:** **Bounded / beam-like best-first search** with expansion budget, branching cap, open-set size cap, and **greedy deterministic tail** — **not** exact A\* on the full graph.

| Criterion | Assessment |
|-----------|------------|
| State | Partial order + remaining ID multiset + last passenger |
| g / h / f | Weighted transition + heuristic remainder + sum |
| Priority queue | Array + sort each iteration — correct ordering intent, poor asymptotics |
| Full expansion (exact) | Yes for all candidates at each node when N≤9 |
| Branching (bounded) | Capped (`BOUNDED_MAX_BRANCHING_CANDIDATES`) |
| Open set pruning | Bounded trims lowest-f after cap |
| Fallback tail | `deterministicTailOrder` — greedy completion |
| Admissibility | **Not established**; units differ from simulator ticks |
| Optimizes | **Abstract cost**, not measured ticks |
| Determinism | No `Math.random` inside A\* implementations — deterministic given inputs |
| Passenger limits | Exact limited to 9; larger N falls back to bounded with warning |
| Groups | **Ignored** by A\* permutations |

**Clear statement:** **Exact path:** “This is **true A\*** (on the defined abstract permutation state space) for N≤9, but the objective is **not** the simulator.” **Bounded path:** “This is **bounded A\* / beam-style search** with a greedy tail, **not** exact A\* on the full state space.”

**Scientific honesty recommendations:** Rename or subtitle outputs to “**Permutation search (weighted cost)**”; add optional **tick oracle** (run fast sim on candidate order) or learn weights; document non-admissibility; report confidence intervals over seeds.

### 10. Comparison mode fairness

- **Same base set:** `ComparisonController` builds `basePassengerSet` once, passes to each `Simulation` as `basePassengerSet` — **good**.
- **Cloning:** `clonePassengers` per simulation — **separate mutable state**.
- **Random algorithms:** New shuffle per simulation — **intentionally different order** for random vs same blueprint numbers — **fair for “typical run”** but **not reproducible**.
- **Winner:** Lowest `tickCount` when all finished — consistent with single metric.
- **Progress:** `seatedCount / totalPassengers` — consistent.
- **Caveat:** Changing passenger count or checkboxes without reset can leave stale comparison state until user resets.

### 11. Input mode / queue mode

- **No** distinct UI modes for “random queue” vs “algorithm-prepared” beyond: blueprint generation → algorithm `run()` → tick loop.
- **No** accidental cross-run override except shared global registry object (read-only `run` usage).

### 12. Cluster and color logic

- **`assignClustersForAlgorithm`** maps algorithm + seat/row to `clusterId` and `passenger.color`.
- **A\*** uses queue order split into four `astar_*` bands for colors.
- **WMA / BTF** colors align with seat/zone semantics.
- **`heuristicCluster`:** Colors still reflect **row bands** from `clusterIdForAlgorithm`, **not** the heuristic ordering buckets — possible mismatch between visual “cluster” and sort priority.
- **Legend:** `legend-note` explains fill = cluster, stroke = state — **clear**.

### 13. UI/UX audit

- Dropdown, pills, comparison checkboxes, profiles, benchmark, counts, speed — present.
- **No** mobile-specific canvas resize logic beyond CSS `width: 100%`; internal canvas resolution fixed 1100×900.
- **Pause** does not disable **Tick** path inconsistently—step still works after pause (acceptable).
- Boot errors show banner for missing DOM / algorithms — **good**.
- Typo: profile label `Aeltere Person` — cosmetic.

### 14. Performance audit

- **Comparison:** `stepAll` runs one tick per simulation per interval — **O(numAlgorithms × rows)** per wave; at 180 passengers × many algorithms, UI thread load grows.
- **A\* exact:** factorial explosion prevented by N≤9 cap.
- **Bounded A\*:** Caps limit worst case.
- **Renderer:** Full redraw every tick / pointer move hit-test builds draw list — fine at prototype scale.
- **Memory:** New objects on reset; no unbounded growth in steady state beyond table DOM churn.

### 15. Architecture audit

- **Separation:** Simulation vs Renderer is clean; algorithms isolated in `algorithms.js`.
- **Globals:** `window.BoardingAlgorithms`, `window.groupPassengersForBoarding` — testability modest.
- **Registry validation:** `getAlgorithmRegistry` filters allowlisted / shaped entries.
- **Backend:** Would mirror JSON passenger list + algorithm key + optional seed; return tick traces or summary stats.

### 16. GitHub Pages compatibility

- **No build**; **no** npm deps; scripts local and ordered; works without backend.

### 17. Backend readiness

- **`main.py`:** Placeholder `healthcheck` only — **no** FastAPI, **no** routes.
- **Suggested future:** `POST /simulate` with `{ passengers, algorithm, seed, maxTicks }` → `{ ticks, traces, metrics }`; `GET /health`.

### 18. Documentation audit

- README covers structure, local server, Pages, high-level algorithm list, profiles, comparison fairness **at a conceptual level**.
- **Gaps:** `prototypeCluster` / cluster timing bug not documented; A\* vs tick objective not emphasized; no “run N seeds” guidance; roadmap duplicates seat interference.

---

## Algorithm Review

| Algorithm | Type | Correctness | Realism | Determinism | Performance | Main issue | Recommendation |
|-----------|------|-------------|---------|-------------|-------------|------------|----------------|
| random | Queue shuffle | OK | Low–Med | No | Excellent | High variance | Multiple seeds / mean ticks |
| backToFront | Row sort | OK | Med | Yes (typical) | Excellent | Shuffle redundant | Remove dead shuffle or add real groups |
| windowMiddleAisle | Zoned WMA | OK | Med | Yes | Excellent | Correlation risk | Optional stochastic tie-break study |
| prototypeCluster | Row-band clusters | **Fails intent** | N/A | Partial | Good | Cluster IDs too late | Assign bands from `targetSeat.row` in algorithm |
| heuristicCluster | Heuristic sort | OK | Med | Yes | Good | Color vs order mismatch | Align legend or color by order buckets |
| exactAStar | Optimized (A\*) | OK for abstract | Low link to sim | Yes | OK N≤9 | Wrong objective | Tick-based eval or relabel |
| boundedAStar | Optimized (bounded) | Heuristic | Low link to sim | Yes | Bounded | Tail greed | Same + document limits |

---

## A\* Review

- **Structure:** `exactAStar` is a **standard A\***-shaped search on permutation states for **N ≤ 9** with **complete branching** and **map-based** `g`-dominance pruning.
- **Objective mismatch:** Transition and heuristic costs are **engineering weights**, not outputs of `Simulation.tick()`.
- **Bounded variant:** Honestly **not** full A\* — **budgeted expansion**, **candidate pruning**, **open-set truncation**, **deterministic greedy tail**.

---

## Comparison Mode Review

- **Fair at blueprint level** (identical passenger parameters per clone).
- **Not statistically fair** as a single draw — **random** and interference RNG differ run-to-run.
- **Reproducibility:** **None** without seeds.

---

## Issue List

| ID | Severity | Category | File | Area | Issue | Fix |
|----|----------|----------|------|------|-------|-----|
| P1 | High | Algorithm | `app.js` | `Simulation` ctor order | `assignClustersForAlgorithm` runs **after** `orderPassengers`; `prototypeCluster` reads `clusterId` too early | Compute cluster bands from `targetSeat.row` inside `prototypeCluster` **or** assign visual clusters before sort in a two-pass API |
| P2 | High | Algorithm / research | `algorithms.js` | `exactAStar` / `boundedAStar` | Optimizes weighted cost, **not** ticks | Add tick oracle eval or rename UI/docs to “weighted permutation search” |
| P3 | High | Comparison fairness | `app.js` / `algorithms.js` | RNG | No seed; random + interference differ each run | Add `seed` field to UI + PRNG; optional batch runs |
| P4 | Medium | Algorithm | `algorithms.js` | `backToFront` | `randomOrder` before row sort ineffective for singleton groups | Remove shuffle or create real multi-passenger groups |
| P5 | Medium | Architecture | `app.js` | Registry | `astarOptimized` in allowlist but **not** implemented | Remove allowlist entry or implement alias |
| P6 | Medium | Documentation | `README.md` | Roadmap | Seat interference listed as future though implemented | Update roadmap |
| P7 | Medium | UX / metrics | `app.js` | Stats | No aisle-block or stow-sum metrics | Add optional diagnostics row |
| P8 | Low | Simulation | `app.js` | `calculateSeatInterferenceTime` | Random components per blocker only | Optional deterministic or occupant-based model |
| P9 | Low | UI copy | `app.js` | Profiles | “Aeltere” typo | Correct string |
| P10 | Info | Groups | `app.js` | `createPassengerBlueprints` | No family generator | Document or add optional generator |

---

## Top 10 Fixes

1. Fix **`prototypeCluster`** ordering relative to cluster semantics (row-based bands in algorithm).
2. Align **A\*** naming and docs with **actual objective** (or add tick-based evaluation).
3. Add **seeded RNG** for reproducible comparison and paper-style tables.
4. Remove or repurpose **dead `randomOrder`** in `backToFront` for singleton groups.
5. Clean **allowlist** (`astarOptimized`) vs exports.
6. **Calibrate** or **separate** “theory cost” vs “observed ticks” in UI.
7. Add **N-run aggregation** (mean, std, win rate) for comparison table.
8. **README** sync: roadmap, A\* limitations, cluster color semantics for heuristic cluster.
9. Optional **metrics**: aisle occupancy integral, stow time sums.
10. Optional **family generator** + queue constraints to justify group-aware claims.

**Recommended order:** 1 → 3 → 2 → 6 → 7 → 4 → 5 → 8 → 9 → 10.

---

## Recommended Roadmap

- **Immediate fixes:** `prototypeCluster` band logic; seeding; README corrections; allowlist cleanup.
- **Next prototype milestone:** Tick oracle for ordered lists; comparison statistics over seeds; clearer optimized-panel labeling.
- **Optimization milestone:** Replace abstract A\* costs with simulation-informed surrogate or small permutation search evaluated by fast-forward sim.
- **Backend milestone:** FastAPI `POST /simulate` + JSON schema; optional headless runner for batch experiments.
- **Research / advanced milestone:** Families, 3D or twin-aisle option, calibrated distributions from data, proper experimental design (confidence intervals).

---

## Final Readiness Rating (1–10)

| Dimension | Rating | Notes |
|-----------|--------|--------|
| Demo readiness | 8 | Works static, visually clear |
| Code quality | 6 | Readable; globals and ordering footguns |
| Simulation realism | 4 | Teaching model, not operational |
| Algorithm quality | 5 | Useful diversity; scientific claims need restraint |
| UI quality | 7 | Coherent; dense on small screens |
| Architecture quality | 6 | Modular core; coupling via globals |
| Research usefulness | 3 | Needs seeds + objective alignment + batch stats |

**Readiness summary**

| Gate | Ready? |
|------|--------|
| Demo | **Yes** |
| School / university presentation | **Yes**, with caveats on A\* |
| GitHub public release | **Yes** as prototype; label limitations prominently |
| Serious optimization experiments | **Not yet** |

---

*End of audit.*
