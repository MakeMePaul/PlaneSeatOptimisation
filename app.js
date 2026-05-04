(function runAeroBoard() {
  "use strict";

  /** Set `?aeroboardDebug=1` on the URL to log registry load and profile distribution tables. */
  const AEROBOARD_DEBUG_LOGS =
    typeof window !== "undefined" &&
    typeof URLSearchParams !== "undefined" &&
    new URLSearchParams(window.location.search).get("aeroboardDebug") === "1";

  const ROWS = 30;
  const SEATS = ["A", "B", "C", "D", "E", "F"];
  const SEAT_INTERFERENCE_RANGE = [3, 8];
  const MIN_TICK_INTERVAL = 1;
  const MAX_TICK_INTERVAL = 2000;
  const CLUSTER_COLORS = {
    random: "#8a96a1",
    zone_back: "#3366cc",
    zone_middle: "#ff9900",
    zone_front: "#109618",
    window: "#0099c6",
    middle: "#dc3912",
    aisle: "#990099",
    cluster_1: "#3366cc",
    cluster_2: "#dc3912",
    cluster_3: "#ff9900",
    cluster_4: "#109618",
    astar_1: "#3366cc",
    astar_2: "#109618",
    astar_3: "#ff9900",
    astar_4: "#dc3912",
    steffen_window_odd: "#1a5276",
    steffen_window_even: "#5dade2",
    steffen_middle_odd: "#1e8449",
    steffen_middle_even: "#58d68d",
    steffen_aisle_odd: "#b9770e",
    steffen_aisle_even: "#f5b041",
  };

  const PASSENGER_PROFILES = {
    business: { label: "Business", probability: 0.15, stowTimeRange: [3, 8], moveCooldown: 0 },
    standard: { label: "Standard", probability: 0.5, stowTimeRange: [6, 14], moveCooldown: 0 },
    elderly: { label: "Aeltere Person", probability: 0.1, stowTimeRange: [10, 22], moveCooldown: 1 },
    child: { label: "Kind", probability: 0.1, stowTimeRange: [8, 18], moveCooldown: 1 },
    heavy_luggage: { label: "Viel Gepaeck", probability: 0.15, stowTimeRange: [15, 30], moveCooldown: 0 },
  };
  const PROFILE_KEYS = Object.keys(PASSENGER_PROFILES);

  const BATCH_TICKS_PER_CHUNK = 5000;

  /**
   * Mulberry32-style PRNG; returns floats in [0, 1).
   */
  function createSeededRng(seed) {
    let state = seed >>> 0;
    return {
      next() {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
    };
  }

  function parseBlueprintSeed(raw) {
    if (raw === undefined || raw === null) {
      return 12345 >>> 0;
    }
    const s = String(raw).trim();
    if (s === "") {
      return 12345 >>> 0;
    }
    const n = Number(s);
    if (Number.isFinite(n)) {
      return Math.trunc(n) >>> 0;
    }
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function addUint32(a, b) {
    return (a + b) >>> 0;
  }

  function randomUint32() {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return buf[0] >>> 0;
    }
    return (Math.imul(Date.now(), 0x9e3779b1) ^ (performance.now() * 1e6)) >>> 0;
  }

  /**
   * Deterministic mix of blueprint seed and algorithm key for one full simulation
   * (queue build + all ticks). Separate from blueprint generation stream.
   */
  function mixSimulationSeed(blueprintSeed, algorithmKey) {
    let h = blueprintSeed >>> 0;
    const str = String(algorithmKey);
    for (let i = 0; i < str.length; i += 1) {
      h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    }
    return h >>> 0;
  }

  function sampleStandardDeviation(values) {
    const n = values.length;
    if (n <= 1) {
      return 0;
    }
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += values[i];
    }
    const mean = sum / n;
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      const d = values[i] - mean;
      acc += d * d;
    }
    return Math.sqrt(acc / (n - 1));
  }

  function getSelectedComparisonAlgorithmKeys() {
    const checkboxes = Array.from(document.querySelectorAll(".algorithm-checkbox-grid input[type='checkbox']"));
    return checkboxes.filter((box) => box.checked).map((box) => box.value);
  }

  function sanitizeBatchRunCount(rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      return 20;
    }
    return Math.max(1, Math.min(200, Math.round(parsed)));
  }

  function randomIntInclusive(min, max, rng) {
    return min + Math.floor(rng.next() * (max - min + 1));
  }

  function pickProfileKey(rng) {
    const roll = rng.next();
    let cumulative = 0;
    for (const profileKey of PROFILE_KEYS) {
      cumulative += PASSENGER_PROFILES[profileKey].probability;
      if (roll <= cumulative) {
        return profileKey;
      }
    }
    return PROFILE_KEYS[PROFILE_KEYS.length - 1];
  }

  function resolveClusterColor(clusterId) {
    return CLUSTER_COLORS[clusterId] || "#8a96a1";
  }

  function sanitizeTickInterval(rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      return 350;
    }
    return Math.max(MIN_TICK_INTERVAL, Math.min(MAX_TICK_INTERVAL, Math.round(parsed)));
  }

  function logProfileDistribution(passengers, enableProfiles) {
    const distribution = {};
    for (const profileKey of PROFILE_KEYS) {
      distribution[profileKey] = 0;
    }
    for (const passenger of passengers) {
      const key = passenger.profileKey || "unknown";
      if (!Object.prototype.hasOwnProperty.call(distribution, key)) {
        distribution[key] = 0;
      }
      distribution[key] += 1;
    }
    if (AEROBOARD_DEBUG_LOGS) {
      console.log("Profiles enabled:", enableProfiles);
      console.table(
        Object.entries(distribution).map(([profileKey, count]) => ({
          profileKey,
          count,
        }))
      );
    }
  }

  function isValidPassengerEntity(candidate) {
    return Boolean(
      candidate &&
        typeof candidate === "object" &&
        candidate.targetSeat &&
        Number.isFinite(candidate.targetSeat.row) &&
        typeof candidate.targetSeat.seat === "string"
    );
  }

  let validatedAlgorithmRegistry = {};

  function getAlgorithmRegistry() {
    const source = window.BoardingAlgorithms;
    if (!source || typeof source !== "object") {
      console.error("BoardingAlgorithms missing or not an object on window.");
      return { registry: {}, entries: [], error: "Registry fehlt." };
    }
    const entries = [];
    const legacyAlgorithmAllowlist = new Set([
      "random",
      "backToFront",
      "windowMiddleAisle",
      "steffenDeterministic",
      "prototypeCluster",
      "heuristicCluster",
      "exactAStar",
      "boundedAStar",
      "astarOptimized",
      "tickSearch",
      "rowBinInterleave",
    ]);
    const legacyPassengerOrderHint = {
      random: "randomize",
      backToFront: "tiebreak",
      windowMiddleAisle: "tiebreak",
      steffenDeterministic: "tiebreak",
      prototypeCluster: "tiebreak",
      heuristicCluster: "optimize",
      exactAStar: "optimize",
      boundedAStar: "optimize",
      astarOptimized: "optimize",
      tickSearch: "optimize",
      rowBinInterleave: "tiebreak",
    };
    for (const [mapKey, candidate] of Object.entries(source)) {
      if (typeof candidate === "function") {
        if (!legacyAlgorithmAllowlist.has(mapKey)) {
          continue;
        }
        // Legacy fallback: support old registry shape { key: runFn }.
        const normalized = {
          key: mapKey,
          label:
            mapKey === "backToFront"
              ? "Back-to-Front"
              : mapKey === "windowMiddleAisle"
                ? "Window-Middle-Aisle (zoned)"
                : mapKey === "prototypeCluster"
                  ? "Prototype Cluster"
                  : mapKey === "heuristicCluster"
                    ? "Heuristic Cluster"
                    : mapKey === "exactAStar"
                      ? "Exact A* (cost model)"
                      : mapKey === "boundedAStar" || mapKey === "astarOptimized"
                        ? "Bounded A* (cost model)"
            : mapKey === "tickSearch"
              ? "Tick Search (sampled)"
              : mapKey === "rowBinInterleave"
                ? "Row-bin interleave"
                : mapKey === "steffenDeterministic"
                  ? "Steffen (deterministic)"
                  : mapKey.charAt(0).toUpperCase() + mapKey.slice(1),
          type:
            mapKey === "heuristicCluster" ||
            mapKey === "exactAStar" ||
            mapKey === "boundedAStar" ||
            mapKey === "astarOptimized" ||
            mapKey === "tickSearch"
              ? "optimized"
              : "normal",
          passengerOrderHint: legacyPassengerOrderHint[mapKey] || "tiebreak",
          run: candidate,
        };
        entries.push(normalized);
        continue;
      }
      if (!candidate || typeof candidate !== "object") {
        console.error(`Algorithm entry "${mapKey}" is not an object.`);
        continue;
      }
      const hasFields =
        typeof candidate.key === "string" &&
        typeof candidate.label === "string" &&
        (candidate.type === "normal" || candidate.type === "optimized") &&
        typeof candidate.run === "function";
      if (!hasFields) {
        console.error(`Algorithm entry "${mapKey}" invalid. Required: key, label, type, run.`);
        continue;
      }
      const mergedHint =
        candidate.passengerOrderHint || legacyPassengerOrderHint[candidate.key] || "tiebreak";
      entries.push({ ...candidate, passengerOrderHint: mergedHint });
    }
    if (entries.length === 0) {
      console.error("No valid algorithms found in BoardingAlgorithms.");
      return { registry: {}, entries: [], error: "Keine gueltigen Algorithmen." };
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "normal" ? -1 : 1;
      }
      return a.label.localeCompare(b.label);
    });
    const registry = {};
    for (const item of entries) {
      registry[item.key] = item;
    }
    return { registry, entries, error: null };
  }

  function algorithmLabelForKey(key) {
    const registry = validatedAlgorithmRegistry;
    const resolvedKey = key === "astarOptimized" ? "boundedAStar" : key;
    return registry[resolvedKey] ? registry[resolvedKey].label : key;
  }

  function algorithmTypeForKey(key) {
    const registry = validatedAlgorithmRegistry;
    const resolvedKey = key === "astarOptimized" ? "boundedAStar" : key;
    return registry[resolvedKey] ? registry[resolvedKey].type : "normal";
  }

  const PASSENGER_ORDER_HINT_LABELS = {
    randomize: "Zufall",
    tiebreak: "Gleichstand",
    optimize: "Optimierung",
  };

  const PASSENGER_ORDER_HINT_TITLES = {
    randomize:
      "Die Boarding-Warteschlange wird zufaellig aus der Passagiermenge gebildet (RNG/Seed). Die Reihenfolge beim Erzeugen der Passagierliste spielt keine Rolle.",
    tiebreak:
      "Die Warteschlange folgt festen Sitz-/Zonen-Regeln. Die Passagierreihenfolge im Blueprint wirkt nur bei Gleichstaenden der Sortierkeys oder wenn Gruppen (groupId) zusammen bleiben.",
    optimize:
      "Das Verfahren sucht oder optimiert eine Boarding-Reihenfolge; die Reihenfolge ist Kern des Modells, nicht die urspruengliche Eingangsreihenfolge.",
  };

  function passengerOrderHintForItem(item) {
    const h = item && item.passengerOrderHint;
    if (h === "randomize" || h === "tiebreak" || h === "optimize") {
      return h;
    }
    return "tiebreak";
  }

  function appendPassengerOrderMark(parent, hint) {
    const mark = document.createElement("span");
    mark.className = `algo-order-tag algo-order-tag--${hint}`;
    mark.textContent = PASSENGER_ORDER_HINT_LABELS[hint];
    mark.setAttribute("title", PASSENGER_ORDER_HINT_TITLES[hint]);
    parent.appendChild(mark);
  }

  function clusterIdForAlgorithm(targetSeat, algorithmKey) {
    const row = targetSeat.row;
    const seat = targetSeat.seat;
    if (algorithmKey === "backToFront") {
      if (row >= 21) return "zone_back";
      if (row >= 11) return "zone_middle";
      return "zone_front";
    }
    if (algorithmKey === "windowMiddleAisle") {
      if (seat === "A" || seat === "F") return "window";
      if (seat === "B" || seat === "E") return "middle";
      return "aisle";
    }
    if (algorithmKey === "steffenDeterministic") {
      const odd = Number.isFinite(row) && Math.trunc(row) % 2 === 1;
      const suffix = odd ? "odd" : "even";
      if (seat === "A" || seat === "F") return `steffen_window_${suffix}`;
      if (seat === "B" || seat === "E") return `steffen_middle_${suffix}`;
      return `steffen_aisle_${suffix}`;
    }
    if (algorithmKey === "prototypeCluster" || algorithmKey === "heuristicCluster" || algorithmKey === "rowBinInterleave") {
      if (row <= 8) return "cluster_1";
      if (row <= 16) return "cluster_2";
      if (row <= 24) return "cluster_3";
      return "cluster_4";
    }
    return "random";
  }

  function assignClustersForAlgorithm(passengers, algorithmKey) {
    if (
      algorithmKey === "astarOptimized" ||
      algorithmKey === "exactAStar" ||
      algorithmKey === "boundedAStar" ||
      algorithmKey === "tickSearch"
    ) {
      assignAstarClustersFromOrderedPassengers(passengers);
      return;
    }
    for (const passenger of passengers) {
      const clusterId = clusterIdForAlgorithm(passenger.targetSeat, algorithmKey);
      passenger.clusterId = clusterId;
      passenger.color = resolveClusterColor(clusterId);
    }
  }

  function assignAstarClustersFromOrderedPassengers(orderedPassengers) {
    const totalPassengers = orderedPassengers.length;
    if (totalPassengers === 0) {
      return;
    }
    const zoneSize = Math.max(1, Math.ceil(totalPassengers / 4));
    for (let index = 0; index < totalPassengers; index += 1) {
      const zoneIndex = Math.min(3, Math.floor(index / zoneSize));
      const clusterId = `astar_${zoneIndex + 1}`;
      const color = resolveClusterColor(clusterId);
      orderedPassengers[index].clusterId = clusterId;
      orderedPassengers[index].color = color;
    }
  }

  function createEmptyRunMetrics() {
    return {
      totalStowingTicks: 0,
      totalSeatingTicks: 0,
      walkingBlockedTicks: 0,
      spawnBlockedTicks: 0,
      maxAisleOccupancy: 0,
    };
  }

  class Passenger {
    constructor(config) {
      this.id = config.id;
      this.targetSeat = config.targetSeat;
      this.currentPosition = null;
      this.stowTime = config.stowTime;
      this.remainingStowTime = config.stowTime;
      this.groupId = config.groupId;
      this.clusterId = config.clusterId;
      this.color = config.color;
      this.profileKey = config.profileKey;
      this.profileLabel = config.profileLabel;
      this.moveCooldown = config.moveCooldown;
      this.moveCooldownTimer = 0;
      this.seatInterferenceTime = 0;
      this.remainingSeatInterferenceTime = 0;
      this.state = "waiting";
      this.waitingTicksInQueue = config.waitingTicksInQueue ?? 0;
    }
  }

  function createPassengerBlueprints(count, rows, seats, rng) {
    const max = Math.min(count, rows * seats.length);
    const seatPool = [];
    for (let row = 1; row <= rows; row += 1) {
      for (const seat of seats) {
        seatPool.push({ row, seat });
      }
    }

    for (let i = seatPool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = seatPool[i];
      seatPool[i] = seatPool[j];
      seatPool[j] = tmp;
    }

    const passengers = [];
    const enableProfiles = ui.enableProfilesCheckbox.checked;
    const benchmarkMode = ui.benchmarkModeCheckbox.checked;
    const standardProfile = PASSENGER_PROFILES.standard;
    for (let i = 0; i < max; i += 1) {
      const profileKey = benchmarkMode ? "standard" : enableProfiles ? pickProfileKey(rng) : "standard";
      const profile = benchmarkMode
        ? standardProfile
        : enableProfiles
          ? PASSENGER_PROFILES[profileKey]
          : standardProfile;
      passengers.push({
        id: i + 1,
        targetSeat: { row: seatPool[i].row, seat: seatPool[i].seat },
        profileKey,
        profileLabel: profile.label,
        stowTime: benchmarkMode ? 10 : randomIntInclusive(profile.stowTimeRange[0], profile.stowTimeRange[1], rng),
        moveCooldown: benchmarkMode ? 0 : profile.moveCooldown,
        groupId: null,
      });
    }
    logProfileDistribution(passengers, benchmarkMode ? false : enableProfiles);
    return passengers;
  }

  function clonePassengers(basePassengers) {
    return basePassengers.map(
      (base) =>
        new Passenger({
          id: base.id,
          targetSeat: { row: base.targetSeat.row, seat: base.targetSeat.seat },
          stowTime: base.stowTime,
          groupId: base.groupId ?? null,
          clusterId: base.clusterId || "random",
          color: resolveClusterColor(base.clusterId || "random"),
          profileKey: base.profileKey,
          profileLabel: base.profileLabel,
          moveCooldown: base.moveCooldown,
        })
    );
  }

  class Plane {
    constructor(rows, seats) {
      this.rows = rows;
      this.seatLetters = seats.slice();
      this.seats = {};
      for (let row = 1; row <= rows; row += 1) {
        this.seats[row] = {};
        for (const seatLetter of this.seatLetters) {
          this.seats[row][seatLetter] = null;
        }
      }
      this.aisle = Array.from({ length: rows }, () => null);
    }

    isAisleFree(position) {
      return this.aisle[position] === null;
    }

    setAisle(position, passenger) {
      this.aisle[position] = passenger;
      if (passenger) {
        passenger.currentPosition = position;
      }
    }

    getSeat(row, seat) {
      if (!this.seats[row] || !Object.prototype.hasOwnProperty.call(this.seats[row], seat)) {
        return null;
      }
      return this.seats[row][seat];
    }

    isSeatOccupied(row, seat) {
      return this.getSeat(row, seat) !== null;
    }

    seatPassenger(passenger) {
      const row = passenger.targetSeat.row;
      const seat = passenger.targetSeat.seat;

      if (!this.seats[row] || !Object.prototype.hasOwnProperty.call(this.seats[row], seat)) {
        return false;
      }
      if (this.seats[row][seat] !== null) {
        return false;
      }

      this.seats[row][seat] = passenger;
      return true;
    }

    getOccupiedSeatsCount() {
      let occupied = 0;
      for (let row = 1; row <= this.rows; row += 1) {
        for (const seatLetter of this.seatLetters) {
          if (this.seats[row][seatLetter] !== null) {
            occupied += 1;
          }
        }
      }
      return occupied;
    }
  }

  class Simulation {
    constructor(config) {
      this.rows = config.rows;
      this.seats = config.seats;
      this.totalPassengers = config.totalPassengers;
      this.algorithm = config.algorithm;
      this.blueprintSeed = config.blueprintSeed >>> 0;
      this.algorithmDisplayName = algorithmLabelForKey(this.algorithm);
      this.algorithmRegistry = config.algorithmRegistry || window.BoardingAlgorithms || {};
      this.plane = new Plane(this.rows, this.seats);
      this.tickCount = 0;
      if (config.rng && typeof config.rng.next === "function") {
        this.rng = config.rng;
      } else {
        this.rng = createSeededRng(mixSimulationSeed(this.blueprintSeed, this.algorithm));
      }
      const basePassengerSet = Array.isArray(config.basePassengerSet) ? config.basePassengerSet : null;
      const blueprintRng = createSeededRng(this.blueprintSeed);
      const sourceBlueprints =
        basePassengerSet || createPassengerBlueprints(this.totalPassengers, this.rows, this.seats, blueprintRng);
      this.allPassengers = clonePassengers(sourceBlueprints);
      this.waitingQueue = this.orderPassengers(this.algorithm);
      if (this.algorithm === "exactAStar" && this.totalPassengers > 9) {
        this.algorithmDisplayName = "Exact A* (cost model) → Bounded A* (cost model)";
      }
      if (
        this.algorithm === "astarOptimized" ||
        this.algorithm === "exactAStar" ||
        this.algorithm === "boundedAStar" ||
        this.algorithm === "tickSearch"
      ) {
        assignClustersForAlgorithm(this.waitingQueue, this.algorithm);
      } else {
        assignClustersForAlgorithm(this.allPassengers, this.algorithm);
      }
      this.boardingPreviewPlan = this.waitingQueue.map((p, i) => ({
        order: i + 1,
        id: p.id,
        row: p.targetSeat.row,
        seat: p.targetSeat.seat,
        profileKey: p.profileKey,
        profileLabel: p.profileLabel,
        clusterId: p.clusterId,
        color: p.color,
      }));
      this.runMetrics = createEmptyRunMetrics();
      this.running = false;
    }

    getRunMetricsSnapshot() {
      const n = this.totalPassengers;
      let sumQueueWait = 0;
      for (const passenger of this.allPassengers) {
        sumQueueWait += passenger.waitingTicksInQueue || 0;
      }
      return {
        totalStowingTicks: this.runMetrics.totalStowingTicks,
        totalSeatingTicks: this.runMetrics.totalSeatingTicks,
        walkingBlockedTicks: this.runMetrics.walkingBlockedTicks,
        spawnBlockedTicks: this.runMetrics.spawnBlockedTicks,
        maxAisleOccupancy: this.runMetrics.maxAisleOccupancy,
        avgQueueDelayTicks: n > 0 ? sumQueueWait / n : 0,
      };
    }

    orderPassengers(algorithmName) {
      const registry = this.algorithmRegistry || {};
      const effectiveName = algorithmName === "astarOptimized" ? "boundedAStar" : algorithmName;
      let strategy = registry[effectiveName];
      if (!strategy || typeof strategy.run !== "function") {
        strategy = registry.random;
      }
      if (!strategy || typeof strategy.run !== "function") {
        return this.allPassengers.slice();
      }
      const runOpts = { rng: this.rng, blueprintSeed: this.blueprintSeed };
      try {
        const result = strategy.run(this.allPassengers, runOpts);
        if (!Array.isArray(result)) {
          return this.allPassengers.slice();
        }
        const sanitized = result.filter((item) => isValidPassengerEntity(item));
        if (sanitized.length !== result.length) {
          console.warn(
            `Boarding algorithm "${algorithmName}" produced invalid passengers. Filtered ${
              result.length - sanitized.length
            } entries.`
          );
        }
        return sanitized;
      } catch (error) {
        console.warn(`Boarding algorithm "${algorithmName}" failed. Falling back to random.`, error);
        if (registry.random && typeof registry.random.run === "function") {
          console.warn(`Boarding algorithm "${algorithmName}" missing. Falling back to "random".`);
          const fallback = registry.random.run(this.allPassengers, runOpts);
          return Array.isArray(fallback) ? fallback.filter((item) => isValidPassengerEntity(item)) : this.allPassengers.slice();
        }
        return this.allPassengers.slice();
      }
    }

    spawnPassenger() {
      if (this.waitingQueue.length === 0 || !this.plane.isAisleFree(0)) {
        return;
      }

      let passenger = null;
      while (this.waitingQueue.length > 0 && !passenger) {
        const nextCandidate = this.waitingQueue.shift();
        if (isValidPassengerEntity(nextCandidate)) {
          passenger = nextCandidate;
        } else {
          console.warn("Skipping invalid passenger candidate in queue:", nextCandidate);
        }
      }
      if (!passenger) {
        return;
      }
      passenger.state = "walking";
      passenger.moveCooldownTimer = 0;
      this.plane.setAisle(0, passenger);
    }

    updateStowing() {
      for (let i = 0; i < this.plane.aisle.length; i += 1) {
        const passenger = this.plane.aisle[i];
        if (!passenger) {
          continue;
        }

        if (passenger.state === "stowing") {
          this.runMetrics.totalStowingTicks += 1;
          passenger.remainingStowTime -= 1;
          if (passenger.remainingStowTime <= 0) {
            const interferenceTime = this.calculateSeatInterferenceTime(passenger);
            passenger.seatInterferenceTime = interferenceTime;
            if (interferenceTime > 0) {
              passenger.state = "seating";
              passenger.remainingSeatInterferenceTime = interferenceTime;
            } else {
              this.completeSeatingFromAisle(i, passenger);
            }
          }
          continue;
        }

        if (passenger.state === "seating") {
          this.runMetrics.totalSeatingTicks += 1;
          passenger.remainingSeatInterferenceTime -= 1;
          if (passenger.remainingSeatInterferenceTime <= 0) {
            const wasSeated = this.completeSeatingFromAisle(i, passenger);
            if (!wasSeated) {
              passenger.remainingSeatInterferenceTime = 1;
            }
          }
        }
      }
    }

    calculateSeatInterferenceTime(passenger) {
      const row = passenger.targetSeat.row;
      const seat = passenger.targetSeat.seat;
      const blockingSeatMap = {
        A: ["B", "C"],
        B: ["C"],
        C: [],
        D: [],
        E: ["D"],
        F: ["E", "D"],
      };
      const blockingSeats = blockingSeatMap[seat] || [];

      let totalInterference = 0;
      for (const blockingSeat of blockingSeats) {
        if (this.plane.isSeatOccupied(row, blockingSeat)) {
          totalInterference += randomIntInclusive(SEAT_INTERFERENCE_RANGE[0], SEAT_INTERFERENCE_RANGE[1], this.rng);
        }
      }

      return totalInterference;
    }

    completeSeatingFromAisle(position, passenger) {
      const wasSeated = this.plane.seatPassenger(passenger);
      if (!wasSeated) {
        return false;
      }
      this.plane.setAisle(position, null);
      passenger.currentPosition = null;
      passenger.state = "seated";
      passenger.remainingStowTime = 0;
      passenger.remainingSeatInterferenceTime = 0;
      return true;
    }

    moveWalkingPassengers() {
      for (let i = this.plane.aisle.length - 1; i >= 0; i -= 1) {
        const passenger = this.plane.aisle[i];
        if (!passenger || passenger.state !== "walking") {
          continue;
        }
        if (!isValidPassengerEntity(passenger)) {
          console.warn("Invalid passenger in aisle; removing from aisle slot:", passenger);
          this.plane.setAisle(i, null);
          continue;
        }

        if (passenger.moveCooldownTimer > 0) {
          passenger.moveCooldownTimer -= 1;
          continue;
        }

        const currentRow = i + 1;
        if (currentRow === passenger.targetSeat.row) {
          passenger.state = "stowing";
          passenger.remainingStowTime = passenger.stowTime;
          continue;
        }

        const nextPos = i + 1;
        if (nextPos >= this.plane.aisle.length) {
          continue;
        }

        if (this.plane.isAisleFree(nextPos)) {
          this.plane.setAisle(nextPos, passenger);
          this.plane.setAisle(i, null);
          passenger.moveCooldownTimer = passenger.moveCooldown;
        } else {
          this.runMetrics.walkingBlockedTicks += 1;
        }
      }
    }

    tick() {
      this.tickCount += 1;
      for (let qi = 0; qi < this.waitingQueue.length; qi += 1) {
        const waitingPassenger = this.waitingQueue[qi];
        if (waitingPassenger && isValidPassengerEntity(waitingPassenger)) {
          waitingPassenger.waitingTicksInQueue += 1;
        }
      }
      this.updateStowing();
      this.moveWalkingPassengers();
      if (this.waitingQueue.length > 0 && !this.plane.isAisleFree(0)) {
        this.runMetrics.spawnBlockedTicks += 1;
      }
      this.spawnPassenger();
      const aisleOccupancy = this.counts().aisle;
      if (aisleOccupancy > this.runMetrics.maxAisleOccupancy) {
        this.runMetrics.maxAisleOccupancy = aisleOccupancy;
      }
    }

    counts() {
      let aisleCount = 0;
      const seatedCount = this.plane.getOccupiedSeatsCount();

      for (const slot of this.plane.aisle) {
        if (slot) {
          aisleCount += 1;
        }
      }

      return {
        waiting: this.waitingQueue.length,
        aisle: aisleCount,
        seated: seatedCount,
      };
    }

    isFinished() {
      const stats = this.counts();
      return stats.waiting === 0 && stats.aisle === 0;
    }
  }

  function blueprintsFromPassengerList(passengers) {
    return passengers.map((p) => ({
      id: p.id,
      targetSeat: { row: p.targetSeat.row, seat: p.targetSeat.seat },
      stowTime: p.stowTime,
      profileKey: p.profileKey,
      profileLabel: p.profileLabel,
      moveCooldown: p.moveCooldown,
      groupId: p.groupId ?? null,
    }));
  }

  function shufflePassengerIdOrder(ids, rng) {
    const copy = ids.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  /**
   * Samples boarding orders and picks one with the lowest tick count (same physics as the main sim).
   * Used by BoardingAlgorithms.tickSearch from algorithms.js.
   */
  window.__aeroBoardRunTickSearch = function runTickSearchFromPassengers(passengers, rng, blueprintSeed) {
    if (!Array.isArray(passengers) || passengers.length <= 1) {
      return passengers.slice();
    }
    const registry = validatedAlgorithmRegistry;
    const rows = ROWS;
    const seats = SEATS;
    const totalPassengers = passengers.length;
    const blueprints = blueprintsFromPassengerList(passengers);
    const allIds = passengers.map((p) => p.id);
    const bp = blueprintSeed >>> 0;

    function evaluateIdOrder(idOrder) {
      const evalRegistry = {
        __tickEval: {
          key: "__tickEval",
          label: "__tickEval",
          type: "optimized",
          run: (ps) => {
            const byId = new Map(ps.map((p) => [p.id, p]));
            return idOrder.map((id) => byId.get(id)).filter(Boolean);
          },
        },
      };
      const sim = new Simulation({
        rows,
        seats,
        totalPassengers,
        algorithm: "__tickEval",
        algorithmRegistry: evalRegistry,
        basePassengerSet: blueprints,
        blueprintSeed: bp,
        rng,
      });
      while (!sim.isFinished()) {
        sim.tick();
      }
      return sim.tickCount;
    }

    let baselineIds = shufflePassengerIdOrder(allIds, rng);
    if (registry.boundedAStar && typeof registry.boundedAStar.run === "function") {
      const boundedSim = new Simulation({
        rows,
        seats,
        totalPassengers,
        algorithm: "boundedAStar",
        algorithmRegistry: registry,
        basePassengerSet: blueprints,
        blueprintSeed: bp,
        rng,
      });
      baselineIds = boundedSim.waitingQueue.map((p) => p.id);
    }

    const randomTrials = Math.min(48, Math.max(20, Math.floor(80 - totalPassengers / 8)));
    let bestIds = baselineIds;
    let bestTicks = evaluateIdOrder(baselineIds);
    for (let t = 0; t < randomTrials; t += 1) {
      const candidateIds = shufflePassengerIdOrder(allIds, rng);
      const ticks = evaluateIdOrder(candidateIds);
      if (ticks < bestTicks) {
        bestTicks = ticks;
        bestIds = candidateIds;
      }
    }

    function improveByRandomSwaps(ids, ticks, evaluateFn, iterations) {
      let current = ids.slice();
      let bestT = ticks;
      const n = current.length;
      for (let k = 0; k < iterations; k += 1) {
        const i = Math.floor(rng.next() * n);
        const j = Math.floor(rng.next() * n);
        if (i === j) {
          continue;
        }
        const next = current.slice();
        const tmp = next[i];
        next[i] = next[j];
        next[j] = tmp;
        const t = evaluateFn(next);
        if (t < bestT) {
          bestT = t;
          current = next;
        }
      }
      return { ids: current, ticks: bestT };
    }

    const swapIterations = Math.min(160, Math.max(48, totalPassengers * 3));
    const improved = improveByRandomSwaps(bestIds, bestTicks, evaluateIdOrder, swapIterations);
    bestIds = improved.ids;

    const byId = new Map(passengers.map((p) => [p.id, p]));
    return bestIds.map((id) => byId.get(id)).filter(Boolean);
  };

  class Renderer {
    constructor(canvas, simulation) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.simulation = simulation;
      this.rows = simulation.plane.rows;
      this.seatLetters = simulation.plane.seatLetters.slice();
      this.padding = 24;
      this.cellHeight = (canvas.height - this.padding * 2) / this.rows;
      this.seatSize = 20;
      this.seatGap = 11;
      this.aisleWidth = 62;
      this.leftBlockWidth = this.seatSize * 3 + this.seatGap * 2;
      /** Abstand Sitzblock ↔ Gang */
      this.gapSeatAisle = 24;
      /** Spalte für Reihennummern (links der Kabine) */
      this.rowLabelColumnWidth = 60;
      this.cabinInnerWidth =
        this.leftBlockWidth + this.gapSeatAisle + this.aisleWidth + this.gapSeatAisle + this.leftBlockWidth;
      this.layoutWidth = this.rowLabelColumnWidth + this.cabinInnerWidth;
      /** Horizontal zentriert: Kabine + Beschriftung in die Canvas-Mitte */
      this.originX = Math.max(this.padding, (canvas.width - this.layoutWidth) / 2);
      this.passengerDrawPoints = [];
    }

    /** Linke X-Position des ABC-Sitzblocks (Sitzmittelpunkte). */
    cabinLeftStart() {
      return this.originX + this.rowLabelColumnWidth;
    }

    /** Vertikale Mitte der Sitzreihe `row` (0-basiert). */
    rowCenterY(rowIndex) {
      return this.padding + rowIndex * this.cellHeight + this.cellHeight / 2;
    }

    seatPosition(rowIndex, seatLabel) {
      const y = this.rowCenterY(rowIndex);
      const leftStart = this.cabinLeftStart();
      const aisleX = leftStart + this.leftBlockWidth + this.gapSeatAisle;
      const rightStart = aisleX + this.aisleWidth + this.gapSeatAisle;
      const seatOffsets = { A: 0, B: 1, C: 2, D: 0, E: 1, F: 2 };

      if (seatLabel === "A" || seatLabel === "B" || seatLabel === "C") {
        return { x: leftStart + seatOffsets[seatLabel] * (this.seatSize + this.seatGap), y };
      }
      return { x: rightStart + seatOffsets[seatLabel] * (this.seatSize + this.seatGap), y };
    }

    aislePosition(rowIndex) {
      const leftStart = this.cabinLeftStart();
      const aisleX = leftStart + this.leftBlockWidth + this.gapSeatAisle;
      const y = this.rowCenterY(rowIndex);
      return { x: aisleX + this.aisleWidth / 2, y };
    }

    drawBasePlane() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = "#f1f7ff";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";

      const leftStart = this.cabinLeftStart();
      const aisleX = leftStart + this.leftBlockWidth + this.gapSeatAisle;
      const rightStart = aisleX + this.aisleWidth + this.gapSeatAisle;

      ctx.fillStyle = "#dbe5ef";
      ctx.fillRect(aisleX, this.padding, this.aisleWidth, this.canvas.height - this.padding * 2);

      for (let row = 0; row < this.rows; row += 1) {
        for (const seat of this.seatLetters) {
          const pos = this.seatPosition(row, seat);
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#b8c5d1";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.rect(pos.x - this.seatSize / 2, pos.y - this.seatSize / 2, this.seatSize, this.seatSize);
          ctx.fill();
          ctx.stroke();
        }
        ctx.fillStyle = "#5f6f7b";
        ctx.font = "600 14px Segoe UI, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const labelColMid = this.originX + this.rowLabelColumnWidth / 2;
        ctx.fillText(String(row + 1), labelColMid, this.rowCenterY(row));
      }

      ctx.fillStyle = "#38526b";
      ctx.font = "600 14px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const letterY = this.padding - 4;
      const pitch = this.seatSize + this.seatGap;
      for (let i = 0; i < 3; i += 1) {
        ctx.fillText(String.fromCharCode(65 + i), leftStart + i * pitch, letterY);
      }
      for (let i = 0; i < 3; i += 1) {
        ctx.fillText(String.fromCharCode(68 + i), rightStart + i * pitch, letterY);
      }

      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }

    drawPassengerCircle(x, y, passenger) {
      const ctx = this.ctx;
      const radius = 9;
      ctx.beginPath();
      ctx.fillStyle = passenger.color;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();

      if (passenger.state === "stowing") {
        ctx.strokeStyle = "#ff8a00";
      } else if (passenger.state === "seating") {
        ctx.strokeStyle = "#7b61ff";
      } else if (passenger.state === "walking") {
        ctx.strokeStyle = "#0b6cff";
      } else if (passenger.state === "seated") {
        ctx.strokeStyle = "#2ea44f";
      } else {
        ctx.strokeStyle = "#8a96a1";
      }
      ctx.lineWidth = 2;
      ctx.stroke();

      const idText = String(passenger.id);
      const fontSize = Math.max(9, radius + 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${fontSize}px Segoe UI`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.lineWidth = 2;
      ctx.strokeText(idText, x, y);
      ctx.fillText(idText, x, y);
    }

    drawPassengers() {
      this.passengerDrawPoints = [];
      const hitR = 11;
      for (let i = 0; i < this.simulation.plane.aisle.length; i += 1) {
        const passenger = this.simulation.plane.aisle[i];
        if (passenger) {
          const aislePos = this.aislePosition(i);
          this.drawPassengerCircle(aislePos.x, aislePos.y, passenger);
          this.passengerDrawPoints.push({ x: aislePos.x, y: aislePos.y, radius: hitR, passenger });
        }
      }

      for (let row = 1; row <= this.simulation.plane.rows; row += 1) {
        for (const seatLetter of this.simulation.plane.seatLetters) {
          const passenger = this.simulation.plane.getSeat(row, seatLetter);
          if (!passenger) {
            continue;
          }

          const rowIndex = row - 1;
          const seatPos = this.seatPosition(rowIndex, seatLetter);
          this.drawPassengerCircle(seatPos.x, seatPos.y, passenger);
          this.passengerDrawPoints.push({ x: seatPos.x, y: seatPos.y, radius: hitR, passenger });
        }
      }
    }

    findPassengerAt(canvasX, canvasY) {
      for (let i = this.passengerDrawPoints.length - 1; i >= 0; i -= 1) {
        const point = this.passengerDrawPoints[i];
        const dx = canvasX - point.x;
        const dy = canvasY - point.y;
        if (dx * dx + dy * dy <= point.radius * point.radius) {
          return point.passenger;
        }
      }
      return null;
    }

    render() {
      this.drawBasePlane();
      this.drawPassengers();
    }
  }

  const ui = {
    canvas: document.getElementById("planeCanvas"),
    algorithmSelect: document.getElementById("algorithmSelect"),
    normalAlgorithmsList: document.getElementById("normalAlgorithmsList"),
    optimizedAlgorithmsList: document.getElementById("optimizedAlgorithmsList"),
    comparisonNormalList: document.getElementById("comparisonNormalList"),
    comparisonOptimizedList: document.getElementById("comparisonOptimizedList"),
    comparisonStartButton: document.getElementById("comparisonStartButton"),
    comparisonResetButton: document.getElementById("comparisonResetButton"),
    comparisonTableBody: document.getElementById("comparisonTableBody"),
    batchRunCountInput: document.getElementById("batchRunCountInput"),
    batchComparisonStartButton: document.getElementById("batchComparisonStartButton"),
    batchComparisonCancelButton: document.getElementById("batchComparisonCancelButton"),
    batchComparisonProgress: document.getElementById("batchComparisonProgress"),
    batchComparisonTableBody: document.getElementById("batchComparisonTableBody"),
    batchExportCsvButton: document.getElementById("batchExportCsvButton"),
    profilesStatus: document.getElementById("profilesStatus"),
    passengerCountInput: document.getElementById("passengerCountInput"),
    speedInput: document.getElementById("speedInput"),
    enableProfilesCheckbox: document.getElementById("enableProfilesCheckbox"),
    benchmarkModeCheckbox: document.getElementById("benchmarkModeCheckbox"),
    startButton: document.getElementById("startButton"),
    pauseButton: document.getElementById("pauseButton"),
    tickButton: document.getElementById("tickButton"),
    resetButton: document.getElementById("resetButton"),
    tickStat: document.getElementById("tickStat"),
    waitingStat: document.getElementById("waitingStat"),
    aisleStat: document.getElementById("aisleStat"),
    seatedStat: document.getElementById("seatedStat"),
    algorithmStat: document.getElementById("algorithmStat"),
    seedInput: document.getElementById("seedInput"),
    newSeedButton: document.getElementById("newSeedButton"),
    activeSeedDisplay: document.getElementById("activeSeedDisplay"),
  };

  const tooltip = document.createElement("div");
  tooltip.style.position = "fixed";
  tooltip.style.display = "none";
  tooltip.style.pointerEvents = "none";
  tooltip.style.zIndex = "20";
  tooltip.style.maxWidth = "280px";
  tooltip.style.padding = "8px 10px";
  tooltip.style.borderRadius = "8px";
  tooltip.style.background = "rgba(24, 32, 38, 0.95)";
  tooltip.style.color = "#ffffff";
  tooltip.style.font = "12px Segoe UI, sans-serif";
  tooltip.style.whiteSpace = "pre-line";
  document.body.appendChild(tooltip);

  function profileSummary(passenger) {
    return [
      `Passenger ID: ${passenger.id}`,
      `Ziel: ${passenger.targetSeat.row}${passenger.targetSeat.seat}`,
      `State: ${passenger.state}`,
      `Profil: ${passenger.profileLabel} (${passenger.profileKey})`,
      `Group ID: ${passenger.groupId ?? "none"}`,
      `Cluster ID: ${passenger.clusterId}`,
      `Remaining Stow: ${passenger.remainingStowTime}`,
      `Remaining Seat Interference: ${passenger.remainingSeatInterferenceTime}`,
    ].join("\n");
  }

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  function showTooltip(passenger, clientX, clientY) {
    tooltip.textContent = profileSummary(passenger);
    tooltip.style.left = `${clientX + 14}px`;
    tooltip.style.top = `${clientY + 14}px`;
    tooltip.style.display = "block";
  }

  function onCanvasPointerMove(event) {
    if (!singleController || !singleController.renderer || !singleController.simulation) {
      hideTooltip();
      return;
    }
    const rect = ui.canvas.getBoundingClientRect();
    const scaleX = ui.canvas.width / rect.width;
    const scaleY = ui.canvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;
    const passenger = singleController.renderer.findPassengerAt(canvasX, canvasY);

    if (!passenger) {
      hideTooltip();
      return;
    }
    showTooltip(passenger, event.clientX, event.clientY);
  }

  function updateProfilesStatusBadge() {
    const enabled = ui.enableProfilesCheckbox.checked;
    ui.profilesStatus.textContent = enabled ? "Profile aktiv" : "Profile deaktiviert";
    ui.profilesStatus.classList.toggle("enabled", enabled);
  }

  function setAlgorithmUiEnabled(enabled) {
    ui.startButton.disabled = !enabled;
    ui.tickButton.disabled = !enabled;
    ui.comparisonStartButton.disabled = !enabled;
    ui.batchComparisonStartButton.disabled = !enabled;
    if (ui.batchExportCsvButton) {
      ui.batchExportCsvButton.disabled = !enabled;
    }
  }

  function getSimulationConfigFromUi() {
    const requestedPassengers = Number(ui.passengerCountInput.value) || 60;
    const boundedPassengers = Math.max(1, Math.min(180, requestedPassengers));
    ui.passengerCountInput.value = String(boundedPassengers);
    const fallbackAlgorithm =
      ui.algorithmSelect.value ||
      (ui.algorithmSelect.options.length > 0 ? ui.algorithmSelect.options[0].value : "random");

    return {
      rows: ROWS,
      seats: SEATS,
      totalPassengers: boundedPassengers,
      algorithm: fallbackAlgorithm,
      algorithmRegistry: validatedAlgorithmRegistry,
      blueprintSeed: parseBlueprintSeed(ui.seedInput.value),
    };
  }

  /** Short token for cabin map (phase mode). */
  function clusterPhaseAbbrev(clusterId) {
    const id = String(clusterId || "random");
    const map = {
      random: "R",
      zone_back: "Zb",
      zone_middle: "Zm",
      zone_front: "Zv",
      window: "W",
      middle: "M",
      aisle: "G",
      cluster_1: "K1",
      cluster_2: "K2",
      cluster_3: "K3",
      cluster_4: "K4",
      astar_1: "A1",
      astar_2: "A2",
      astar_3: "A3",
      astar_4: "A4",
      steffen_window_odd: "Wo",
      steffen_window_even: "We",
      steffen_middle_odd: "Mo",
      steffen_middle_even: "Me",
      steffen_aisle_odd: "Go",
      steffen_aisle_even: "Ge",
    };
    return map[id] || id.slice(0, 4);
  }

  /** Human-readable phase / cluster label (DE + key). */
  function clusterPhaseDescription(clusterId) {
    const id = String(clusterId || "random");
    const labels = {
      random: "Zufall / keine Phase",
      zone_back: "Zone hinten (Back-to-Front)",
      zone_middle: "Zone mitte",
      zone_front: "Zone vorne",
      window: "Window (WMA)",
      middle: "Middle (WMA)",
      aisle: "Aisle (WMA)",
      cluster_1: "Cluster Band 1 (vorne)",
      cluster_2: "Cluster Band 2",
      cluster_3: "Cluster Band 3",
      cluster_4: "Cluster Band 4 (hinten)",
      astar_1: "A* / Tick-Suche — Phase 1 (frueh)",
      astar_2: "A* / Tick-Suche — Phase 2",
      astar_3: "A* / Tick-Suche — Phase 3",
      astar_4: "A* / Tick-Suche — Phase 4 (spaet)",
      steffen_window_odd: "Steffen: Window ungerade",
      steffen_window_even: "Steffen: Window gerade",
      steffen_middle_odd: "Steffen: Middle ungerade",
      steffen_middle_even: "Steffen: Middle gerade",
      steffen_aisle_odd: "Steffen: Aisle ungerade",
      steffen_aisle_even: "Steffen: Aisle gerade",
    };
    return labels[id] || id;
  }

  /** Plain-language summary of how the selected algorithm orders boarding (UI only). */
  function algorithmLogicPlainLanguage(algorithmKey) {
    const key = algorithmKey === "astarOptimized" ? "boundedAStar" : algorithmKey;
    const map = {
      random:
        "Zufaellige Reihenfolge: Passagiere werden per Zufall in die Warteschlange gemischt; es gibt keine raeumliche oder zeitliche Prioritaet.",
      backToFront:
        "Back-to-Front: Passagiere mit Sitzplaetzen weiter hinten im Flugzeug steigen zuerst ein (innerhalb von Reihengruppen kann die Reihenfolge variieren).",
      windowMiddleAisle:
        "Window–Middle–Aisle: Zuerst Fensterplaetze, dann Mitte, dann Gang — pro Kabinenzone, um Blockaden durch Einsteigen ueber andere Sitze zu reduzieren.",
      steffenDeterministic:
        "Steffen-artig: Verschachtelte Reihenfolge nach Fenster/Mitte/Gang und geraden/ungeraden Reihen, damit sich Passagiere im Gang weniger gegenseitig blockieren.",
      prototypeCluster:
        "Cluster-Baender: Passagiere werden in wenige hintereinander einsteigende Reihenbaender (von vorne nach hinten) gruppiert.",
      heuristicCluster:
        "Heuristische Cluster: Aehnlich Band-Clustern, mit einer heuristischen Kostenlogik zur Gruppierung der Einsteigereihenfolge.",
      rowBinInterleave:
        "Zeilen-Bins mit Versatz: Reihen werden in Bins eingeteilt und mit Versatz gemischt, um Staus im Gang zu streuen.",
      exactAStar:
        "Exakter A*: Sucht (bei sehr wenigen Passagieren) eine Reihenfolge mit minimalem Surrogat-Kostenmodell; bei mehr Passagieren greift ein Fallback.",
      boundedAStar:
        "Begrenzter A*: Sucht eine guenstige Reihenfolge mit begrenztem Suchaufwand (Surrogatkosten); gemessene Ticks kommen danach aus der Simulation.",
      tickSearch:
        "Tick-Suche: Iterative Suche nach einer Reihenfolge, die ein internes Kostenmass verbessert; beobachtete Boarding-Zeit ist weiterhin die Tick-Simulation.",
    };
    if (map[key]) {
      return map[key];
    }
    const reg = validatedAlgorithmRegistry[key];
    if (reg && reg.label) {
      return `${reg.label}: Reihenfolge wird vom registrierten Verfahren gebildet; Details siehe Algorithmus-Implementierung.`;
    }
    return "Reihenfolge wird vom gewaehlten Algorithmus aus der Registry gebildet.";
  }

  function previewRankHeatColor(order, totalSteps) {
    const n = Math.max(1, totalSteps - 1);
    const t = totalSteps <= 1 ? 0 : (order - 1) / n;
    const saturation = 58 + t * 8;
    const lightness = 30 + t * 54;
    return `hsl(215, ${saturation}%, ${lightness}%)`;
  }

  function buildBoardingPreviewPlanFromUi(algorithmKey) {
    const config = getSimulationConfigFromUi();
    const blueprintSeed = config.blueprintSeed >>> 0;
    const blueprintRng = createSeededRng(blueprintSeed);
    const base = createPassengerBlueprints(config.totalPassengers, config.rows, config.seats, blueprintRng);
    const sim = new Simulation({
      rows: config.rows,
      seats: config.seats,
      totalPassengers: config.totalPassengers,
      algorithm: algorithmKey,
      algorithmRegistry: validatedAlgorithmRegistry,
      basePassengerSet: base,
      blueprintSeed,
    });
    return sim.boardingPreviewPlan || [];
  }

  function compareBatchRowsDefault(a, b) {
    if (a.mean !== b.mean) {
      return a.mean - b.mean;
    }
    if (a.winRate !== b.winRate) {
      return b.winRate - a.winRate;
    }
    if (a.std !== b.std) {
      return a.std - b.std;
    }
    const c = a.label.localeCompare(b.label);
    if (c !== 0) {
      return c;
    }
    return String(a.key).localeCompare(String(b.key));
  }

  function getBatchRowSortValue(row, column) {
    switch (column) {
      case "label":
        return row.label;
      case "type":
        return row.typeKey === "optimized" ? "Optimiert" : "Normal";
      case "runs":
        return row.runs;
      case "meanTicks":
        return row.mean;
      case "stdTicks":
        return row.std;
      case "minTicks":
        return row.min;
      case "maxTicks":
        return row.max;
      case "wins":
        return row.w;
      case "winRate":
        return row.winRate;
      case "meanStow":
        return row.mStowNum;
      case "meanSeat":
        return row.mSeatNum;
      case "meanWalk":
        return row.mWalkNum;
      case "meanSpawn":
        return row.mSpawnNum;
      case "meanMaxAisle":
        return row.mMaxAisleNum;
      case "meanAvgWait":
        return row.mQNum;
      default:
        return row.mean;
    }
  }

  function compareBatchRowsByColumn(a, b, column, ascending) {
    const va = getBatchRowSortValue(a, column);
    const vb = getBatchRowSortValue(b, column);
    const dir = ascending ? 1 : -1;
    if (typeof va === "string" && typeof vb === "string") {
      const s = va.localeCompare(vb) * dir;
      if (s !== 0) {
        return s;
      }
    } else {
      const na = Number(va);
      const nb = Number(vb);
      const fa = Number.isFinite(na);
      const fb = Number.isFinite(nb);
      if (fa && fb && na !== nb) {
        return na < nb ? -dir : dir;
      }
      if (fa !== fb) {
        return fa ? -1 : 1;
      }
    }
    return compareBatchRowsDefault(a, b);
  }

  function defaultBatchSortAscending(column) {
    if (column === "winRate" || column === "wins") {
      return false;
    }
    return true;
  }

  function updateBatchTableHeaderSortMarkers(batchController) {
    const table = document.getElementById("batchComparisonTable");
    if (!table || !batchController) {
      return;
    }
    const col = batchController.batchSortColumn || "meanTicks";
    const asc = batchController.batchSortAscending !== false;
    table.querySelectorAll("thead th[data-batch-sort]").forEach((th) => {
      const active = th.dataset.batchSort === col;
      th.classList.toggle("batch-sort-active", active);
      if (active) {
        th.setAttribute("aria-sort", asc ? "ascending" : "descending");
      } else {
        th.removeAttribute("aria-sort");
      }
    });
  }

  function initBatchTableHeaderSort(batchController) {
    const table = document.getElementById("batchComparisonTable");
    if (!table) {
      return;
    }
    const thead = table.querySelector("thead");
    if (!thead || thead.dataset.sortInit === "1") {
      return;
    }
    thead.dataset.sortInit = "1";
    thead.addEventListener("click", (event) => {
      const th = event.target.closest("th[data-batch-sort]");
      if (!th || !batchController) {
        return;
      }
      const col = th.dataset.batchSort;
      if (!col) {
        return;
      }
      if (batchController.batchSortColumn === col) {
        batchController.batchSortAscending = !batchController.batchSortAscending;
      } else {
        batchController.batchSortColumn = col;
        batchController.batchSortAscending = defaultBatchSortAscending(col);
      }
      updateBatchTableHeaderSortMarkers(batchController);
      batchController.renderTable();
    });
  }

  function initSidebarMode() {
    const buttons = document.querySelectorAll(".sidebar-mode-btn[data-sidebar-mode]");
    const panels = document.querySelectorAll(".sidebar-mode-panel[data-sidebar-mode]");
    if (buttons.length === 0 || panels.length === 0) {
      return;
    }
    const applyMode = (mode) => {
      buttons.forEach((btn) => {
        const on = btn.dataset.sidebarMode === mode;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      panels.forEach((panel) => {
        const on = panel.dataset.sidebarMode === mode;
        panel.classList.toggle("is-active", on);
      });
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => applyMode(btn.dataset.sidebarMode));
    });
    applyMode("single");
  }

  function initResultsTabs() {
    const tabs = document.querySelectorAll(".results-tab[role='tab']");
    const panels = document.querySelectorAll(".results-tab-panel[role='tabpanel']");
    if (tabs.length === 0 || panels.length === 0) {
      return;
    }
    const activate = (panelId) => {
      tabs.forEach((tab) => {
        const on = tab.getAttribute("aria-controls") === panelId;
        tab.classList.toggle("is-active", on);
        tab.setAttribute("aria-selected", on ? "true" : "false");
      });
      panels.forEach((panel) => {
        const on = panel.id === panelId;
        panel.classList.toggle("is-active", on);
      });
    };
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => activate(tab.getAttribute("aria-controls")));
    });
    const first = tabs[0] && tabs[0].getAttribute("aria-controls");
    if (first) {
      activate(first);
    }
  }

  function initBatchAdvancedToggle() {
    const btn = document.getElementById("batchAdvancedMetricsToggle");
    const region = document.getElementById("batchTableRegion");
    if (!btn || !region) {
      return;
    }
    btn.addEventListener("click", () => {
      region.classList.toggle("batch-metrics-simple");
      const collapsed = region.classList.contains("batch-metrics-simple");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.textContent = collapsed ? "Erweiterte Metriken anzeigen" : "Erweiterte Metriken ausblenden";
    });
  }

  function setKpiText(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) {
      el.textContent = text;
    }
  }

  /** Sync sidebar + canvas toolbar live stats (same data-live-stat key). */
  function syncLiveStat(statKey, text) {
    const nodes = document.querySelectorAll(`[data-live-stat="${statKey}"]`);
    nodes.forEach((el) => {
      el.textContent = text;
    });
    if (statKey === "algorithm") {
      nodes.forEach((el) => {
        el.setAttribute("title", text);
      });
    }
  }

  function updateBatchKpiCards(sortedRows, runsCompleted) {
    const dash = "—";
    if (!sortedRows || sortedRows.length === 0 || runsCompleted < 1) {
      setKpiText("batchKpiBestAlgo", dash);
      setKpiText("batchKpiBestMean", dash);
      setKpiText("batchKpiBestNormal", dash);
      setKpiText("batchKpiBestOpt", dash);
      setKpiText("batchKpiBestWinRate", dash);
      return;
    }
    setKpiText("batchKpiBestAlgo", sortedRows[0].label);
    setKpiText("batchKpiBestMean", sortedRows[0].mean.toFixed(1));
    const normalRows = sortedRows.filter((r) => algorithmTypeForKey(r.key) === "normal");
    const optRows = sortedRows.filter((r) => algorithmTypeForKey(r.key) === "optimized");
    if (normalRows.length > 0) {
      const bestN = normalRows.reduce((a, b) => (a.mean <= b.mean ? a : b));
      setKpiText("batchKpiBestNormal", `${bestN.label} (${bestN.mean.toFixed(1)})`);
    } else {
      setKpiText("batchKpiBestNormal", dash);
    }
    if (optRows.length > 0) {
      const bestO = optRows.reduce((a, b) => (a.mean <= b.mean ? a : b));
      setKpiText("batchKpiBestOpt", `${bestO.label} (${bestO.mean.toFixed(1)})`);
    } else {
      setKpiText("batchKpiBestOpt", dash);
    }
    let maxWinRate = -1;
    for (const r of sortedRows) {
      if (Number.isFinite(r.winRate) && r.winRate > maxWinRate) {
        maxWinRate = r.winRate;
      }
    }
    if (Number.isFinite(maxWinRate) && maxWinRate >= 0) {
      const tied = sortedRows.filter((r) => r.winRate === maxWinRate);
      tied.sort((a, b) => a.label.localeCompare(b.label));
      const pct = maxWinRate.toFixed(1);
      let winText;
      if (tied.length === 1) {
        winText = `${tied[0].label} (${pct}%)`;
      } else if (tied.length === 2) {
        winText = `${tied[0].label}, ${tied[1].label} (${pct}%)`;
      } else {
        winText = `${tied[0].label} (+${tied.length - 1}) (${pct}%)`;
      }
      setKpiText("batchKpiBestWinRate", winText);
    } else {
      setKpiText("batchKpiBestWinRate", dash);
    }
  }

  function sortBatchRowObjects(rows, column, ascending) {
    const col = column || "meanTicks";
    const asc = ascending !== false;
    const slice = rows.slice();
    if (col === "meanTicks" && asc) {
      slice.sort(compareBatchRowsDefault);
      return slice;
    }
    slice.sort((a, b) => compareBatchRowsByColumn(a, b, col, asc));
    return slice;
  }

  function buildSortedBatchExportKeys(selectedKeys, runsCompleted, tickSamples, metricSamples) {
    if (selectedKeys.length === 0 || runsCompleted < 1) {
      return selectedKeys.slice();
    }
    const wins = new Map();
    for (let r = 0; r < runsCompleted; r += 1) {
      const rowTicks = selectedKeys.map((k) => {
        const arr = tickSamples.get(k) || [];
        return arr[r];
      });
      const finite = rowTicks.filter((t) => Number.isFinite(t));
      if (finite.length !== selectedKeys.length) {
        continue;
      }
      const minT = Math.min(...finite);
      for (let i = 0; i < selectedKeys.length; i += 1) {
        if (rowTicks[i] === minT) {
          const k = selectedKeys[i];
          wins.set(k, (wins.get(k) || 0) + 1);
        }
      }
    }
    const rows = selectedKeys.map((key) => {
      const samples = tickSamples.get(key) || [];
      const n = samples.length;
      const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
      const std = sampleStandardDeviation(samples);
      const w = wins.get(key) || 0;
      const winRate = runsCompleted > 0 ? (100 * w) / runsCompleted : 0;
      return {
        key,
        label: algorithmLabelForKey(key),
        mean,
        std,
        winRate,
        wins: w,
        runs: runsCompleted,
      };
    });
    const sorted = sortBatchRowObjects(rows, "meanTicks", true);
    return sorted.map((r) => r.key);
  }

  function renderAlgorithmPreview() {
    const strip = document.getElementById("algorithmPreviewStrip");
    const cabin = document.getElementById("algorithmPreviewCabin");
    const phases = document.getElementById("algorithmPreviewPhases");
    const selectEl = document.getElementById("previewAlgorithmSelect");
    const explanationEl = document.getElementById("algorithmPreviewExplanation");
    if (!strip || !cabin || !phases || !selectEl) {
      return;
    }
    const algorithmKey = selectEl.value || ui.algorithmSelect.value;
    if (explanationEl) {
      explanationEl.textContent = algorithmLogicPlainLanguage(algorithmKey);
    }
    const orderMode =
      !document.getElementById("previewModePhase") || !document.getElementById("previewModePhase").checked;
    let plan = [];
    try {
      plan = buildBoardingPreviewPlanFromUi(algorithmKey);
    } catch (err) {
      console.warn("Algorithm preview build failed.", err);
    }

    const totalSteps = plan.length;
    const previewTooltip = (step) => {
      const cid = String(step.clusterId || "random");
      return [
        `Boarding-Position: ${step.order}`,
        `Passenger ID: ${step.id}`,
        `Sitz: Reihe ${step.row}, Platz ${step.seat}`,
        `Profil: ${step.profileLabel} (${step.profileKey})`,
        `Phase / Cluster: ${clusterPhaseDescription(cid)} (${clusterPhaseAbbrev(cid)})`,
      ].join("\n");
    };

    strip.innerHTML = "";
    let groupEl = null;
    let cellsRow = null;
    let prevCluster = null;
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      const cid = String(step.clusterId || "random");
      if (i === 0 || cid !== prevCluster) {
        groupEl = document.createElement("div");
        groupEl.className = "preview-strip-group";
        const lab = document.createElement("span");
        lab.className = "preview-strip-group-label";
        lab.textContent = clusterPhaseAbbrev(cid);
        lab.title = clusterPhaseDescription(cid);
        groupEl.appendChild(lab);
        cellsRow = document.createElement("div");
        cellsRow.className = "preview-strip-group-cells";
        groupEl.appendChild(cellsRow);
        strip.appendChild(groupEl);
        prevCluster = cid;
      }
      const cell = document.createElement("span");
      cell.className = "preview-strip-cell";
      cell.style.backgroundColor = previewRankHeatColor(step.order, Math.max(1, totalSteps));
      cell.title = previewTooltip(step);
      cellsRow.appendChild(cell);
    }

    cabin.innerHTML = "";
    const seatLetters = SEATS;
    const corner = document.createElement("div");
    corner.className = "cabin-corner";
    cabin.appendChild(corner);
    for (const letter of seatLetters) {
      const h = document.createElement("div");
      h.className = "cabin-seat-h";
      h.textContent = letter;
      cabin.appendChild(h);
    }

    const bySeat = Object.create(null);
    for (const step of plan) {
      bySeat[`${step.row}|${step.seat}`] = step;
    }

    for (let row = 1; row <= ROWS; row += 1) {
      const rl = document.createElement("div");
      rl.className = "cabin-row-label";
      rl.textContent = String(row);
      cabin.appendChild(rl);
      for (const letter of seatLetters) {
        const cell = document.createElement("div");
        const step = bySeat[`${row}|${letter}`];
        if (step) {
          cell.className = "cabin-cell";
          const heat = previewRankHeatColor(step.order, Math.max(1, totalSteps));
          cell.style.backgroundColor = heat;
          cell.style.borderColor = "rgba(0,0,0,0.2)";
          const inner = orderMode ? String(step.order) : clusterPhaseAbbrev(step.clusterId);
          cell.textContent = inner.length > 3 ? inner.slice(0, 3) : inner;
          cell.title = previewTooltip(step);
        } else {
          cell.className = "cabin-cell cabin-cell-empty";
          cell.textContent = "·";
        }
        cabin.appendChild(cell);
      }
    }

    phases.innerHTML = "";
    if (totalSteps === 0) {
      const emptyChip = document.createElement("div");
      emptyChip.className = "preview-phase-chip preview-phase-chip--empty";
      emptyChip.textContent = "Keine Daten (Passagierzahl 0 oder Fehler).";
      phases.appendChild(emptyChip);
    } else {
      const seen = new Set();
      const phaseRows = [];
      for (const step of plan) {
        const cid = step.clusterId || "random";
        if (seen.has(cid)) {
          continue;
        }
        seen.add(cid);
        phaseRows.push({ cid, step });
      }
      const onlyUndifferentiatedRandom = phaseRows.length === 1 && String(phaseRows[0].cid) === "random";
      if (onlyUndifferentiatedRandom) {
        const chip = document.createElement("div");
        chip.className = "preview-phase-chip preview-phase-chip--neutral";
        chip.textContent = "Keine getrennten Phasen (einheitliche Warteschlange).";
        phases.appendChild(chip);
      } else {
        for (const { cid, step } of phaseRows) {
          const chip = document.createElement("div");
          chip.className = "preview-phase-chip";
          const sw = document.createElement("span");
          sw.className = "preview-phase-swatch";
          sw.style.backgroundColor = step.color || resolveClusterColor(cid);
          const text = document.createElement("span");
          text.textContent = `${clusterPhaseAbbrev(String(cid))} — ${clusterPhaseDescription(String(cid))}`;
          chip.appendChild(sw);
          chip.appendChild(text);
          phases.appendChild(chip);
        }
      }
    }
  }

  function syncPreviewAlgorithmSelectOptions() {
    const selectEl = document.getElementById("previewAlgorithmSelect");
    if (!selectEl || !ui.algorithmSelect) {
      return;
    }
    const keys = [];
    const add = (k) => {
      if (!k || keys.includes(k)) {
        return;
      }
      if (!validatedAlgorithmRegistry[k]) {
        return;
      }
      keys.push(k);
    };
    add(ui.algorithmSelect.value);
    for (const k of getSelectedComparisonAlgorithmKeys()) {
      add(k);
    }
    const prev = selectEl.value;
    selectEl.innerHTML = "";
    for (const key of keys) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = algorithmLabelForKey(key);
      const reg = validatedAlgorithmRegistry[key];
      if (reg) {
        opt.title = `${algorithmLabelForKey(key)} — Passagierreihenfolge: ${
          PASSENGER_ORDER_HINT_TITLES[passengerOrderHintForItem(reg)]
        }`;
      }
      selectEl.appendChild(opt);
    }
    if (keys.includes(prev)) {
      selectEl.value = prev;
    } else {
      selectEl.value = ui.algorithmSelect.value;
    }
    renderAlgorithmPreview();
  }

  function showBootError(message) {
    const errorBanner = document.createElement("div");
    errorBanner.style.margin = "16px";
    errorBanner.style.padding = "12px 14px";
    errorBanner.style.border = "1px solid #dc3912";
    errorBanner.style.borderRadius = "8px";
    errorBanner.style.background = "#ffe9e5";
    errorBanner.style.color = "#7a1f14";
    errorBanner.style.font = "14px Segoe UI, sans-serif";
    errorBanner.textContent = message;
    document.body.prepend(errorBanner);
  }

  function updateActiveSeedDisplay() {
    if (!ui.activeSeedDisplay) {
      return;
    }
    ui.activeSeedDisplay.textContent = String(parseBlueprintSeed(ui.seedInput.value));
  }

  function onSeedSettingsChanged() {
    updateActiveSeedDisplay();
    if (singleController) {
      singleController.stop();
      hideTooltip();
      singleController.reset();
    }
    if (comparisonController) {
      comparisonController.reset();
    }
  }

  function validateUiRefs(uiRefs) {
    const idByKey = {
      canvas: "planeCanvas",
      algorithmSelect: "algorithmSelect",
      normalAlgorithmsList: "normalAlgorithmsList",
      optimizedAlgorithmsList: "optimizedAlgorithmsList",
      comparisonNormalList: "comparisonNormalList",
      comparisonOptimizedList: "comparisonOptimizedList",
      comparisonStartButton: "comparisonStartButton",
      comparisonResetButton: "comparisonResetButton",
      comparisonTableBody: "comparisonTableBody",
      batchRunCountInput: "batchRunCountInput",
      batchComparisonStartButton: "batchComparisonStartButton",
      batchComparisonCancelButton: "batchComparisonCancelButton",
      batchComparisonProgress: "batchComparisonProgress",
      batchComparisonTableBody: "batchComparisonTableBody",
      batchExportCsvButton: "batchExportCsvButton",
      profilesStatus: "profilesStatus",
      passengerCountInput: "passengerCountInput",
      speedInput: "speedInput",
      enableProfilesCheckbox: "enableProfilesCheckbox",
      benchmarkModeCheckbox: "benchmarkModeCheckbox",
      startButton: "startButton",
      pauseButton: "pauseButton",
      tickButton: "tickButton",
      resetButton: "resetButton",
      tickStat: "tickStat",
      waitingStat: "waitingStat",
      aisleStat: "aisleStat",
      seatedStat: "seatedStat",
      algorithmStat: "algorithmStat",
      seedInput: "seedInput",
      newSeedButton: "newSeedButton",
      activeSeedDisplay: "activeSeedDisplay",
    };
    const missingIds = [];
    for (const [key, elementId] of Object.entries(idByKey)) {
      if (!uiRefs[key]) {
        missingIds.push(elementId);
      }
    }
    if (missingIds.length > 0) {
      console.error("AeroBoard boot validation failed. Missing DOM IDs:", missingIds);
      showBootError(
        `AeroBoard konnte nicht gestartet werden. Fehlende DOM-Elemente: ${missingIds.join(", ")}.`
      );
      return false;
    }
    return true;
  }

  function appendEmptyAlgorithmState(message) {
    const normal = document.createElement("p");
    normal.className = "algorithm-empty";
    normal.textContent = message;
    const optimized = normal.cloneNode(true);
    ui.normalAlgorithmsList.appendChild(normal);
    ui.optimizedAlgorithmsList.appendChild(optimized);
  }

  function syncAlgorithmPillSelection(ui) {
    const key = ui.algorithmSelect && ui.algorithmSelect.value;
    const parents = [ui.normalAlgorithmsList, ui.optimizedAlgorithmsList];
    for (const list of parents) {
      if (!list) {
        continue;
      }
      list.querySelectorAll("button.algorithm-pill[data-algorithm-key]").forEach((btn) => {
        const on = btn.getAttribute("data-algorithm-key") === key;
        btn.classList.toggle("is-selected", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
  }

  function initAlgorithmPillLists(ui) {
    function onPillClick(event) {
      const btn = event.target.closest("button.algorithm-pill[data-algorithm-key]");
      if (!btn) {
        return;
      }
      const inNormal = ui.normalAlgorithmsList && ui.normalAlgorithmsList.contains(btn);
      const inOpt = ui.optimizedAlgorithmsList && ui.optimizedAlgorithmsList.contains(btn);
      if (!inNormal && !inOpt) {
        return;
      }
      const pillKey = btn.getAttribute("data-algorithm-key");
      if (!pillKey || !ui.algorithmSelect) {
        return;
      }
      if (ui.algorithmSelect.value === pillKey) {
        return;
      }
      ui.algorithmSelect.value = pillKey;
      ui.algorithmSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (ui.normalAlgorithmsList) {
      ui.normalAlgorithmsList.addEventListener("click", onPillClick);
    }
    if (ui.optimizedAlgorithmsList) {
      ui.optimizedAlgorithmsList.addEventListener("click", onPillClick);
    }
  }

  function renderAlgorithmControls() {
    const { registry, entries, error } = getAlgorithmRegistry();
    validatedAlgorithmRegistry = registry;
    const metadata = entries;
    const normal = metadata.filter((item) => item.type === "normal");
    const optimized = metadata.filter((item) => item.type === "optimized");

    ui.algorithmSelect.innerHTML = "";
    ui.normalAlgorithmsList.innerHTML = "";
    ui.optimizedAlgorithmsList.innerHTML = "";
    ui.comparisonNormalList.innerHTML = "";
    ui.comparisonOptimizedList.innerHTML = "";

    if (metadata.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Keine Algorithmen geladen";
      ui.algorithmSelect.appendChild(option);
      ui.algorithmSelect.value = "";
      appendEmptyAlgorithmState("Keine Algorithmen gefunden");
      setAlgorithmUiEnabled(false);
      console.error(`AeroBoard algorithm loading failed: ${error || "Unbekannter Fehler"}`);
      syncPreviewAlgorithmSelectOptions();
      syncAlgorithmPillSelection(ui);
      return;
    }
    setAlgorithmUiEnabled(true);

    function appendAlgorithmPill(container, item) {
      const hint = passengerOrderHintForItem(item);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `algorithm-pill ${item.type === "optimized" ? "optimized" : ""}`;
      btn.dataset.algorithmKey = item.key;
      btn.setAttribute("aria-pressed", "false");
      const labelSpan = document.createElement("span");
      labelSpan.className = "algorithm-pill-label";
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);
      appendPassengerOrderMark(btn, hint);
      container.appendChild(btn);
    }

    function appendComparisonCheckbox(container, item, checked) {
      const hint = passengerOrderHintForItem(item);
      const label = document.createElement("label");
      label.className = "algorithm-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = item.key;
      checkbox.checked = checked;
      checkbox.dataset.algorithmKey = item.key;
      const text = document.createElement("span");
      text.className = "algorithm-checkbox-label";
      text.textContent = item.label;
      const typeBadge = document.createElement("span");
      typeBadge.className = `algo-type-badge ${item.type === "optimized" ? "optimized" : ""}`;
      typeBadge.textContent = item.type === "optimized" ? "Optimiert" : "Normal";
      label.appendChild(checkbox);
      label.appendChild(text);
      label.appendChild(typeBadge);
      appendPassengerOrderMark(label, hint);
      container.appendChild(label);
      checkbox.addEventListener("change", () => {
        syncPreviewAlgorithmSelectOptions();
      });
    }

    for (const item of metadata) {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = item.label;
      option.title = `${item.label} — Passagierreihenfolge: ${
        PASSENGER_ORDER_HINT_TITLES[passengerOrderHintForItem(item)]
      }`;
      ui.algorithmSelect.appendChild(option);
    }
    const randomExists = metadata.some((item) => item.key === "random");
    ui.algorithmSelect.value = randomExists ? "random" : ui.algorithmSelect.options[0].value;

    for (const item of normal) {
      appendAlgorithmPill(ui.normalAlgorithmsList, item);
      appendComparisonCheckbox(ui.comparisonNormalList, item, item.key === "random");
    }
    for (const item of optimized) {
      appendAlgorithmPill(ui.optimizedAlgorithmsList, item);
      appendComparisonCheckbox(ui.comparisonOptimizedList, item, item.key === "boundedAStar");
    }
    syncPreviewAlgorithmSelectOptions();
    syncAlgorithmPillSelection(ui);
  }

  function emptyMetricsSnapshot() {
    return {
      totalStowingTicks: 0,
      totalSeatingTicks: 0,
      walkingBlockedTicks: 0,
      spawnBlockedTicks: 0,
      maxAisleOccupancy: 0,
      avgQueueDelayTicks: 0,
    };
  }

  function meanMetricSeries(samples, field) {
    const vals = samples.map((s) => s[field]).filter((v) => Number.isFinite(v));
    if (vals.length === 0) {
      return null;
    }
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  function buildBatchSummaryCsv(selectedKeys, runsCompleted, tickSamples, metricSamples) {
    const header =
      "algorithmKey,runs,meanTicks,stdTicks,minTicks,maxTicks,wins,winRatePct,meanStowSum,meanSeatSum,meanWalkBlk,meanSpawnBlk,meanMaxAisle,meanAvgQueueDelay";
    const lines = [header];
    const wins = new Map();
    if (runsCompleted > 0 && selectedKeys.length > 0) {
      for (let r = 0; r < runsCompleted; r += 1) {
        const rowTicks = selectedKeys.map((k) => {
          const arr = tickSamples.get(k) || [];
          return arr[r];
        });
        const finite = rowTicks.filter((t) => Number.isFinite(t));
        if (finite.length !== selectedKeys.length) {
          continue;
        }
        const minT = Math.min(...finite);
        for (let i = 0; i < selectedKeys.length; i += 1) {
          if (rowTicks[i] === minT) {
            const k = selectedKeys[i];
            wins.set(k, (wins.get(k) || 0) + 1);
          }
        }
      }
    }
    const sortedKeys = buildSortedBatchExportKeys(selectedKeys, runsCompleted, tickSamples, metricSamples);
    for (const key of sortedKeys) {
      const samples = tickSamples.get(key) || [];
      const n = samples.length;
      const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
      const std = sampleStandardDeviation(samples);
      const min = n > 0 ? Math.min(...samples) : 0;
      const max = n > 0 ? Math.max(...samples) : 0;
      const w = wins.get(key) || 0;
      const winRate = runsCompleted > 0 ? (100 * w) / runsCompleted : 0;
      const ms = metricSamples.get(key) || [];
      const mStow = meanMetricSeries(ms, "totalStowingTicks");
      const mSeat = meanMetricSeries(ms, "totalSeatingTicks");
      const mWalk = meanMetricSeries(ms, "walkingBlockedTicks");
      const mSpawn = meanMetricSeries(ms, "spawnBlockedTicks");
      const mMaxA = meanMetricSeries(ms, "maxAisleOccupancy");
      const mQ = meanMetricSeries(ms, "avgQueueDelayTicks");
      const fmt = (v) => (v === null ? "" : v.toFixed(2));
      lines.push(
        `${key},${runsCompleted},${mean.toFixed(2)},${std.toFixed(2)},${min},${max},${w},${winRate.toFixed(1)},${fmt(mStow)},${fmt(mSeat)},${fmt(mWalk)},${fmt(mSpawn)},${fmt(mMaxA)},${fmt(mQ)}`
      );
    }
    return lines.join("\n");
  }

  function typeBadgeHtml(algorithmType) {
    const optimized = algorithmType === "optimized";
    const cls = optimized ? "type-badge--optimized" : "type-badge--normal";
    const label = optimized ? "Optimiert" : "Normal";
    return `<span class="type-badge ${cls}">${label}</span>`;
  }

  function createComparisonRowHtml(entry, isWinner, highlightBestAvgWait) {
    const status = entry.finished ? "Fertig" : "Laeuft";
    const progress = entry.totalPassengers <= 0 ? 0 : Math.min(100, Math.round((entry.seatedCount / entry.totalPassengers) * 100));
    const m = entry.metrics || emptyMetricsSnapshot();
    const dash = "—";
    const num = (v) => (Number.isFinite(v) ? String(Math.round(v)) : dash);
    const num1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : dash);
    const avgCls = highlightBestAvgWait ? " col-num cell-best-metric" : " col-num";
    return (
      `<tr class="${isWinner ? "winner" : ""}">` +
      `<td>${entry.algorithmLabel}</td>` +
      `<td>${typeBadgeHtml(entry.algorithmType)}</td>` +
      `<td>${status}</td>` +
      `<td class="col-num">${entry.tickCount}</td>` +
      `<td class="col-num">${entry.waitingCount}</td>` +
      `<td class="col-num">${entry.aisleCount}</td>` +
      `<td class="col-num">${entry.seatedCount}</td>` +
      `<td class="col-num">${progress}%</td>` +
      `<td class="col-num">${num(m.totalStowingTicks)}</td>` +
      `<td class="col-num">${num(m.totalSeatingTicks)}</td>` +
      `<td class="col-num">${num(m.walkingBlockedTicks)}</td>` +
      `<td class="col-num">${num(m.spawnBlockedTicks)}</td>` +
      `<td class="col-num">${num(m.maxAisleOccupancy)}</td>` +
      `<td class="${avgCls.trim()}">${num1(m.avgQueueDelayTicks)}</td>` +
      `</tr>`
    );
  }

  function renderComparisonMetricsTableBody(rows) {
    const tbody = document.getElementById("comparisonMetricsTableBody");
    if (!tbody) {
      return;
    }
    if (!rows || rows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="empty-row">Noch keine abgeschlossenen Vergleichsmetriken.</td></tr>';
      return;
    }
    const allFinished = rows.every((row) => row.finished);
    if (!allFinished) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="empty-row">Vergleich noch nicht beendet.</td></tr>';
      return;
    }
    const sortedRows = rows.slice().sort((a, b) => a.tickCount - b.tickCount);
    const avgVals = sortedRows.map((r) => r.metrics.avgQueueDelayTicks).filter((v) => Number.isFinite(v));
    const minAvgWait = avgVals.length > 0 ? Math.min(...avgVals) : null;
    const dash = "—";
    const num = (v) => (Number.isFinite(v) ? String(Math.round(v)) : dash);
    const num1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : dash);
    tbody.innerHTML = sortedRows
      .map((entry) => {
        const m = entry.metrics || emptyMetricsSnapshot();
        const hi =
          minAvgWait !== null &&
          Number.isFinite(m.avgQueueDelayTicks) &&
          m.avgQueueDelayTicks === minAvgWait;
        const avgCls = hi ? "col-num cell-best-metric" : "col-num";
        return (
          `<tr>` +
          `<td>${entry.algorithmLabel}</td>` +
          `<td>${typeBadgeHtml(entry.algorithmType)}</td>` +
          `<td class="col-num">${entry.tickCount}</td>` +
          `<td class="col-num">${num(m.totalStowingTicks)}</td>` +
          `<td class="col-num">${num(m.totalSeatingTicks)}</td>` +
          `<td class="col-num">${num(m.walkingBlockedTicks)}</td>` +
          `<td class="col-num">${num(m.spawnBlockedTicks)}</td>` +
          `<td class="col-num">${num(m.maxAisleOccupancy)}</td>` +
          `<td class="${avgCls}">${num1(m.avgQueueDelayTicks)}</td>` +
          `</tr>`
        );
      })
      .join("");
  }

  class BatchComparisonController {
    constructor(uiRefs) {
      this.ui = uiRefs;
      this.cancelRequested = false;
      this.running = false;
      this.timeoutId = null;
      this.selectedKeys = [];
      this.totalRuns = 0;
      this.runIndex = 0;
      this.algoIndex = 0;
      this.currentBlueprint = null;
      this.currentBlueprintSeed = null;
      this.currentSim = null;
      this.runTickByKey = null;
      this.tickSamples = new Map();
      this.metricSamples = new Map();
      this.wins = new Map();
      this.runsCompleted = 0;
      this.batchSortColumn = "meanTicks";
      this.batchSortAscending = true;
    }

    getProgressMessage() {
      if (!this.running) {
        return "—";
      }
      if (this.runIndex < this.totalRuns) {
        return `Lauf ${this.runIndex + 1} / ${this.totalRuns}`;
      }
      return "Abschliessend…";
    }

    updateProgressText() {
      this.ui.batchComparisonProgress.textContent = this.getProgressMessage();
    }

    setRunningUi(running) {
      const algoReady = Object.keys(validatedAlgorithmRegistry).length > 0;
      this.ui.batchComparisonStartButton.disabled = running || !algoReady;
      this.ui.batchComparisonCancelButton.disabled = !running;
      if (this.ui.batchExportCsvButton) {
        this.ui.batchExportCsvButton.disabled = running || !algoReady;
      }
      this.ui.comparisonStartButton.disabled = running || !algoReady;
      this.ui.comparisonResetButton.disabled = running;
      this.ui.startButton.disabled = running || !algoReady;
      this.ui.tickButton.disabled = running || !algoReady;
      this.ui.enableProfilesCheckbox.disabled = running;
      this.ui.benchmarkModeCheckbox.disabled = running;
      if (this.ui.seedInput) {
        this.ui.seedInput.disabled = running;
      }
      if (this.ui.newSeedButton) {
        this.ui.newSeedButton.disabled = running;
      }
    }

    renderTable() {
      if (this.selectedKeys.length === 0) {
        this.ui.batchComparisonTableBody.innerHTML =
          '<tr><td colspan="16" class="empty-row">Noch kein Batch-Vergleich gestartet.</td></tr>';
        updateBatchTableHeaderSortMarkers(this);
        updateBatchKpiCards([], 0);
        return;
      }
      const hasData = this.selectedKeys.some((k) => (this.tickSamples.get(k) || []).length > 0);
      if (!this.running && !hasData) {
        this.ui.batchComparisonTableBody.innerHTML =
          '<tr><td colspan="16" class="empty-row">Noch kein Batch-Vergleich gestartet.</td></tr>';
        updateBatchTableHeaderSortMarkers(this);
        updateBatchKpiCards([], 0);
        return;
      }

      const runs = this.runsCompleted;
      const rowObjs = this.selectedKeys.map((key) => {
        const samples = this.tickSamples.get(key) || [];
        const n = samples.length;
        const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
        const std = sampleStandardDeviation(samples);
        const min = n > 0 ? Math.min(...samples) : 0;
        const max = n > 0 ? Math.max(...samples) : 0;
        const w = this.wins.get(key) || 0;
        const winRate = runs > 0 ? (100 * w) / runs : 0;
        const typeKey = algorithmTypeForKey(key);
        const label = algorithmLabelForKey(key);
        const ms = this.metricSamples.get(key) || [];
        const fmt = (v) => (v === null ? "—" : v.toFixed(0));
        const mStow = meanMetricSeries(ms, "totalStowingTicks");
        const mSeat = meanMetricSeries(ms, "totalSeatingTicks");
        const mWalk = meanMetricSeries(ms, "walkingBlockedTicks");
        const mSpawn = meanMetricSeries(ms, "spawnBlockedTicks");
        const mMaxAisle = meanMetricSeries(ms, "maxAisleOccupancy");
        const mQ = meanMetricSeries(ms, "avgQueueDelayTicks");
        return {
          key,
          label,
          typeKey,
          runs,
          mean,
          std,
          min,
          max,
          w,
          winRate,
          mStow,
          mSeat,
          mWalk,
          mSpawn,
          mMaxAisle,
          mQ,
          mStowNum: mStow != null && Number.isFinite(mStow) ? mStow : 0,
          mSeatNum: mSeat != null && Number.isFinite(mSeat) ? mSeat : 0,
          mWalkNum: mWalk != null && Number.isFinite(mWalk) ? mWalk : 0,
          mSpawnNum: mSpawn != null && Number.isFinite(mSpawn) ? mSpawn : 0,
          mMaxAisleNum: mMaxAisle != null && Number.isFinite(mMaxAisle) ? mMaxAisle : 0,
          mQNum: mQ != null && Number.isFinite(mQ) ? mQ : 0,
          fmt,
        };
      });
      const sorted = sortBatchRowObjects(rowObjs, this.batchSortColumn, this.batchSortAscending);
      const bestMeanKey = runs > 0 && sorted.length > 0 ? sorted[0].key : null;
      let bestWinKey = null;
      if (runs > 0 && sorted.length > 0) {
        let maxW = -1;
        const winTie = [];
        for (const r of sorted) {
          if (r.winRate > maxW) {
            maxW = r.winRate;
            winTie.length = 0;
            winTie.push(r.key);
          } else if (r.winRate === maxW && maxW >= 0) {
            winTie.push(r.key);
          }
        }
        if (winTie.length === 1) {
          bestWinKey = winTie[0];
        } else if (winTie.length > 1) {
          winTie.sort((a, b) => String(a).localeCompare(String(b)));
          bestWinKey = winTie[0];
        }
      }
      const html = sorted.map((row) => {
        const isBestMean = bestMeanKey !== null && row.key === bestMeanKey;
        const winExtra =
          bestWinKey !== null &&
          bestMeanKey !== null &&
          bestWinKey !== bestMeanKey &&
          row.key === bestWinKey
            ? " col-winrate-best"
            : "";
        const trCls = isBestMean ? "batch-row-best" : "";
        return (
          `<tr class="${trCls}">` +
          `<td>${row.label}</td>` +
          `<td>${typeBadgeHtml(row.typeKey)}</td>` +
          `<td class="col-num">${row.runs}</td>` +
          `<td class="col-num">${row.mean.toFixed(1)}</td>` +
          `<td class="col-num">${row.std.toFixed(2)}</td>` +
          `<td class="col-num col-batch-advanced">${row.min}</td>` +
          `<td class="col-num col-batch-advanced">${row.max}</td>` +
          `<td class="col-num col-batch-advanced">${row.w}</td>` +
          `<td class="col-num${winExtra}">${row.winRate.toFixed(1)}%</td>` +
          `<td class="col-num col-batch-advanced">${row.fmt(row.mStow)}</td>` +
          `<td class="col-num col-batch-advanced">${row.fmt(row.mSeat)}</td>` +
          `<td class="col-num col-batch-advanced">${row.fmt(row.mWalk)}</td>` +
          `<td class="col-num col-batch-advanced">${row.fmt(row.mSpawn)}</td>` +
          `<td class="col-num col-batch-advanced">${row.fmt(row.mMaxAisle)}</td>` +
          `<td class="col-num">${row.fmt(row.mQ)}</td>` +
          `</tr>`
        );
      });
      this.ui.batchComparisonTableBody.innerHTML = html.join("");
      updateBatchTableHeaderSortMarkers(this);
      updateBatchKpiCards(sorted, runs);
    }

    schedule(fn) {
      this.timeoutId = setTimeout(fn, 0);
    }

    finishBatch(aborted) {
      this.currentSim = null;
      this.running = false;
      this.timeoutId = null;
      this.setRunningUi(false);
      if (aborted) {
        this.ui.batchComparisonProgress.textContent =
          this.runsCompleted > 0 ? `Abgebrochen (${this.runsCompleted} von ${this.totalRuns} Laeufen).` : "Abgebrochen.";
      } else {
        this.ui.batchComparisonProgress.textContent = "Fertig.";
      }
      this.renderTable();
    }

    start() {
      if (this.running) {
        return;
      }
      const keys = getSelectedComparisonAlgorithmKeys();
      if (keys.length === 0) {
        return;
      }
      const totalRuns = sanitizeBatchRunCount(this.ui.batchRunCountInput.value);
      this.ui.batchRunCountInput.value = String(totalRuns);

      this.cancelRequested = false;
      this.running = true;
      this.selectedKeys = keys.slice();
      this.totalRuns = totalRuns;
      this.runIndex = 0;
      this.algoIndex = 0;
      this.currentBlueprint = null;
      this.currentBlueprintSeed = null;
      this.currentSim = null;
      this.runTickByKey = null;
      this.runsCompleted = 0;
      this.tickSamples = new Map(keys.map((k) => [k, []]));
      this.metricSamples = new Map(keys.map((k) => [k, []]));
      this.wins = new Map(keys.map((k) => [k, 0]));
      this.batchSortColumn = "meanTicks";
      this.batchSortAscending = true;

      this.setRunningUi(true);
      this.updateProgressText();
      this.renderTable();
      this.schedule(() => this.processRunStart());
    }

    cancel() {
      if (!this.running) {
        return;
      }
      this.cancelRequested = true;
      if (this.timeoutId !== null) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      this.finishBatch(true);
    }

    processRunStart() {
      if (this.cancelRequested) {
        this.finishBatch(true);
        return;
      }
      if (this.runIndex >= this.totalRuns) {
        this.finishBatch(false);
        return;
      }

      const baseFromUi = parseBlueprintSeed(this.ui.seedInput.value);
      const blueprintSeed = addUint32(baseFromUi, this.runIndex);
      this.currentBlueprintSeed = blueprintSeed;
      const config = getSimulationConfigFromUi();
      const blueprintRng = createSeededRng(blueprintSeed);
      this.currentBlueprint = createPassengerBlueprints(
        config.totalPassengers,
        config.rows,
        config.seats,
        blueprintRng
      );

      this.runTickByKey = Object.create(null);
      this.algoIndex = 0;
      this.updateProgressText();
      this.schedule(() => this.processAlgorithmStart());
    }

    applyWinsForCompletedRun() {
      const keys = this.selectedKeys;
      const ticks = keys.map((k) => this.runTickByKey[k]).filter((t) => Number.isFinite(t));
      if (ticks.length !== keys.length) {
        return;
      }
      const minTicks = Math.min(...ticks);
      for (const key of keys) {
        if (this.runTickByKey[key] === minTicks) {
          this.wins.set(key, (this.wins.get(key) || 0) + 1);
        }
      }
      this.runsCompleted += 1;
    }

    processAlgorithmStart() {
      if (this.cancelRequested) {
        this.finishBatch(true);
        return;
      }
      if (this.algoIndex >= this.selectedKeys.length) {
        this.applyWinsForCompletedRun();
        this.renderTable();
        this.runIndex += 1;
        this.updateProgressText();
        this.schedule(() => this.processRunStart());
        return;
      }

      const algorithmKey = this.selectedKeys[this.algoIndex];

      try {
        const config = getSimulationConfigFromUi();
        this.currentSim = new Simulation({
          rows: config.rows,
          seats: config.seats,
          totalPassengers: config.totalPassengers,
          algorithm: algorithmKey,
          algorithmRegistry: validatedAlgorithmRegistry,
          basePassengerSet: this.currentBlueprint,
          blueprintSeed: this.currentBlueprintSeed,
        });
      } catch (err) {
        console.warn(`Batch simulation failed for "${algorithmKey}".`, err);
        const failTicks = 999999999;
        this.runTickByKey[algorithmKey] = failTicks;
        this.tickSamples.get(algorithmKey).push(failTicks);
        this.currentSim = null;
        this.algoIndex += 1;
        this.schedule(() => this.processAlgorithmStart());
        return;
      }

      this.schedule(() => this.tickChunk());
    }

    tickChunk() {
      if (this.cancelRequested) {
        this.finishBatch(true);
        return;
      }
      if (!this.currentSim) {
        this.schedule(() => this.processAlgorithmStart());
        return;
      }

      let steps = 0;
      while (steps < BATCH_TICKS_PER_CHUNK && !this.currentSim.isFinished()) {
        this.currentSim.tick();
        steps += 1;
      }

      if (this.currentSim.isFinished()) {
        const algorithmKey = this.selectedKeys[this.algoIndex];
        const ticks = this.currentSim.tickCount;
        this.runTickByKey[algorithmKey] = ticks;
        this.tickSamples.get(algorithmKey).push(ticks);
        this.metricSamples.get(algorithmKey).push(this.currentSim.getRunMetricsSnapshot());
        this.currentSim = null;
        this.algoIndex += 1;
        this.schedule(() => this.processAlgorithmStart());
        return;
      }

      this.schedule(() => this.tickChunk());
    }
  }

  class SingleSimulationController {
    constructor(uiRefs) {
      this.ui = uiRefs;
      this.simulation = null;
      this.renderer = null;
      this.timerId = null;
    }

    reset() {
      this.stop();
      this.simulation = new Simulation(getSimulationConfigFromUi());
      this.renderer = new Renderer(this.ui.canvas, this.simulation);
      this.updateStats();
      this.renderer.render();
      syncPreviewAlgorithmSelectOptions();
    }

    stop() {
      if (this.timerId !== null) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      if (this.simulation) {
        this.simulation.running = false;
      }
    }

    updateStats() {
      if (!this.simulation) {
        return;
      }
      const stats = this.simulation.counts();
      syncLiveStat("tick", String(this.simulation.tickCount));
      syncLiveStat("waiting", String(stats.waiting));
      syncLiveStat("aisle", String(stats.aisle));
      syncLiveStat("seated", String(stats.seated));
      syncLiveStat("algorithm", this.simulation.algorithmDisplayName || algorithmLabelForKey(this.simulation.algorithm));
    }

    executeTick() {
      if (!this.simulation || this.simulation.isFinished()) {
        this.stop();
        return;
      }
      this.simulation.tick();
      this.updateStats();
      this.renderer.render();
      if (this.simulation.isFinished()) {
        this.stop();
      }
    }

    start() {
      this.stop();
      if (!this.simulation) {
        return;
      }
      this.simulation.running = true;
      const interval = sanitizeTickInterval(this.ui.speedInput.value);
      this.ui.speedInput.value = String(interval);
      this.timerId = setInterval(() => this.executeTick(), interval);
    }
  }

  class ComparisonController {
    constructor(uiRefs) {
      this.ui = uiRefs;
      this.timerId = null;
      this.basePassengerSet = null;
      this.lastBlueprintSeed = null;
      this.simulations = [];
    }

    getSelectedAlgorithmKeys() {
      return getSelectedComparisonAlgorithmKeys();
    }

    reset() {
      if (this.timerId !== null) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      this.basePassengerSet = null;
      this.lastBlueprintSeed = null;
      this.simulations = [];
      this.renderTable();
    }

    ensureSimulations() {
      const selected = this.getSelectedAlgorithmKeys();
      if (selected.length === 0) {
        this.renderTable();
        return false;
      }

      const blueprintSeed = parseBlueprintSeed(this.ui.seedInput.value);
      const prevKeysStr = this.simulations.map((e) => e.algorithmKey).join("\0");
      const selectedKeysStr = selected.join("\0");
      const needsNewBase =
        !this.basePassengerSet ||
        this.lastBlueprintSeed !== blueprintSeed ||
        prevKeysStr !== selectedKeysStr;

      if (needsNewBase) {
        const config = getSimulationConfigFromUi();
        const blueprintRng = createSeededRng(blueprintSeed);
        this.basePassengerSet = createPassengerBlueprints(
          config.totalPassengers,
          config.rows,
          config.seats,
          blueprintRng
        );
        this.lastBlueprintSeed = blueprintSeed;
        this.simulations = selected.map((algorithmKey) => ({
          algorithmKey,
          algorithmLabel: algorithmLabelForKey(algorithmKey),
          algorithmType: algorithmTypeForKey(algorithmKey),
          sim: new Simulation({
            rows: config.rows,
            seats: config.seats,
            totalPassengers: config.totalPassengers,
            algorithm: algorithmKey,
            algorithmRegistry: validatedAlgorithmRegistry,
            basePassengerSet: this.basePassengerSet,
            blueprintSeed,
          }),
          finished: false,
        }));
      }
      return true;
    }

    stepAll() {
      if (this.simulations.length === 0) {
        return;
      }
      for (const entry of this.simulations) {
        if (entry.finished) {
          continue;
        }
        if (!entry.sim.isFinished()) {
          entry.sim.tick();
        }
        entry.finished = entry.sim.isFinished();
      }
      this.renderTable();

      if (this.simulations.every((entry) => entry.finished)) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
    }

    start() {
      if (!this.ensureSimulations()) {
        return;
      }
      if (this.timerId !== null) {
        return;
      }
      const interval = sanitizeTickInterval(this.ui.speedInput.value);
      this.ui.speedInput.value = String(interval);
      this.timerId = setInterval(() => this.stepAll(), interval);
      this.renderTable();
    }

    restartTimerIfRunning() {
      if (this.timerId === null) {
        return;
      }
      clearInterval(this.timerId);
      const interval = sanitizeTickInterval(this.ui.speedInput.value);
      this.ui.speedInput.value = String(interval);
      this.timerId = setInterval(() => this.stepAll(), interval);
    }

    buildRows() {
      return this.simulations.map((entry) => {
        const counts = entry.sim.counts();
        return {
          algorithmKey: entry.algorithmKey,
          algorithmLabel: entry.sim.algorithmDisplayName || entry.algorithmLabel,
          algorithmType: entry.algorithmType,
          finished: entry.finished,
          tickCount: entry.sim.tickCount,
          waitingCount: counts.waiting,
          aisleCount: counts.aisle,
          seatedCount: counts.seated,
          totalPassengers: entry.sim.totalPassengers,
          metrics: entry.sim.getRunMetricsSnapshot(),
        };
      });
    }

    renderTable() {
      const rows = this.buildRows();
      if (rows.length === 0) {
        this.ui.comparisonTableBody.innerHTML = '<tr><td colspan="15" class="empty-row">Noch kein Vergleich gestartet.</td></tr>';
        renderComparisonMetricsTableBody([]);
        return;
      }

      const allFinished = rows.every((row) => row.finished);
      const sortedRows = allFinished ? rows.slice().sort((a, b) => a.tickCount - b.tickCount) : rows;
      const winnerMinTicks =
        allFinished && sortedRows.length > 0 ? sortedRows[0].tickCount : null;
      const avgVals = allFinished
        ? sortedRows.map((r) => r.metrics.avgQueueDelayTicks).filter((v) => Number.isFinite(v))
        : [];
      const minAvgWait = avgVals.length > 0 ? Math.min(...avgVals) : null;
      this.ui.comparisonTableBody.innerHTML = sortedRows
        .map((row) =>
          createComparisonRowHtml(
            row,
            winnerMinTicks !== null && row.tickCount === winnerMinTicks,
            minAvgWait !== null &&
              Number.isFinite(row.metrics.avgQueueDelayTicks) &&
              row.metrics.avgQueueDelayTicks === minAvgWait
          )
        )
        .join("");
      renderComparisonMetricsTableBody(sortedRows);
    }
  }

  let singleController = null;
  let comparisonController = null;
  let batchComparisonController = null;

  if (typeof globalThis !== "undefined") {
    globalThis.__AeroBoardTestExports = Object.freeze({
      Simulation,
      Plane,
      createSeededRng,
      mixSimulationSeed,
      parseBlueprintSeed,
      ROWS,
      SEATS,
      buildBoardingPreviewPlanFromUi,
    });
  }

  if (!validateUiRefs(ui)) {
    return;
  }
  if (AEROBOARD_DEBUG_LOGS) {
    console.log("Loaded BoardingAlgorithms:", Object.keys(window.BoardingAlgorithms || {}));
  }
  renderAlgorithmControls();
  updateProfilesStatusBadge();
  singleController = new SingleSimulationController(ui);
  comparisonController = new ComparisonController(ui);
  batchComparisonController = new BatchComparisonController(ui);
  initBatchTableHeaderSort(batchComparisonController);
  initSidebarMode();
  initResultsTabs();
  initBatchAdvancedToggle();
  initAlgorithmPillLists(ui);

  const previewAlgoSelect = document.getElementById("previewAlgorithmSelect");
  if (previewAlgoSelect) {
    previewAlgoSelect.addEventListener("change", () => {
      renderAlgorithmPreview();
    });
  }
  for (const radio of document.querySelectorAll('input[name="previewDisplayMode"]')) {
    radio.addEventListener("change", () => {
      renderAlgorithmPreview();
    });
  }

  ui.startButton.addEventListener("click", () => singleController.start());
  ui.pauseButton.addEventListener("click", () => singleController.stop());
  ui.tickButton.addEventListener("click", () => {
    singleController.stop();
    singleController.executeTick();
  });
  ui.resetButton.addEventListener("click", () => {
    singleController.stop();
    hideTooltip();
    singleController.reset();
  });
  ui.algorithmSelect.addEventListener("change", () => {
    singleController.stop();
    hideTooltip();
    singleController.reset();
    syncAlgorithmPillSelection(ui);
  });
  ui.speedInput.addEventListener("input", () => {
    const interval = sanitizeTickInterval(ui.speedInput.value);
    ui.speedInput.value = String(interval);
    if (singleController && singleController.simulation && singleController.simulation.running && singleController.timerId !== null) {
      singleController.start();
    }
    if (comparisonController) {
      comparisonController.restartTimerIfRunning();
    }
  });
  ui.enableProfilesCheckbox.addEventListener("change", () => {
    updateProfilesStatusBadge();
    singleController.stop();
    hideTooltip();
    singleController.reset();
    comparisonController.reset();
  });
  ui.benchmarkModeCheckbox.addEventListener("change", () => {
    singleController.stop();
    hideTooltip();
    singleController.reset();
    comparisonController.reset();
  });
  ui.passengerCountInput.addEventListener("change", () => {
    singleController.stop();
    hideTooltip();
    singleController.reset();
    comparisonController.reset();
  });
  if (ui.seedInput) {
    ui.seedInput.addEventListener("input", () => updateActiveSeedDisplay());
    ui.seedInput.addEventListener("change", () => onSeedSettingsChanged());
  }
  if (ui.newSeedButton) {
    ui.newSeedButton.addEventListener("click", () => {
      ui.seedInput.value = String(randomUint32());
      onSeedSettingsChanged();
    });
  }
  ui.comparisonStartButton.addEventListener("click", () => comparisonController.start());
  ui.comparisonResetButton.addEventListener("click", () => {
    comparisonController.reset();
    syncPreviewAlgorithmSelectOptions();
  });
  ui.batchComparisonStartButton.addEventListener("click", () => {
    comparisonController.reset();
    batchComparisonController.start();
  });
  ui.batchComparisonCancelButton.addEventListener("click", () => batchComparisonController.cancel());
  ui.batchExportCsvButton.addEventListener("click", async () => {
    if (!batchComparisonController || batchComparisonController.runsCompleted < 1) {
      return;
    }
    const text = buildBatchSummaryCsv(
      batchComparisonController.selectedKeys,
      batchComparisonController.runsCompleted,
      batchComparisonController.tickSamples,
      batchComparisonController.metricSamples
    );
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn("Batch CSV clipboard copy failed.", err);
    }
  });
  ui.canvas.addEventListener("mousemove", onCanvasPointerMove);
  ui.canvas.addEventListener("mouseleave", hideTooltip);

  if (Object.keys(validatedAlgorithmRegistry).length === 0) {
    showBootError("AeroBoard konnte keine gueltigen Algorithmen laden. Bitte algorithms.js pruefen.");
    syncLiveStat("algorithm", "-");
  } else {
    singleController.reset();
  }
  updateActiveSeedDisplay();
  comparisonController.renderTable();
  batchComparisonController.renderTable();
})();
