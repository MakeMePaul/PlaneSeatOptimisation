 (function runAeroBoard() {
  "use strict";

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

  /** Base seed for batch run i: blueprintSeed = AEROBOARD_BATCH_BASE_SEED + i */
  const AEROBOARD_BATCH_BASE_SEED = 1_000_003;
  const BATCH_TICKS_PER_CHUNK = 5000;

  let mathRandomBackup = null;

  function installSeededRandom(seed) {
    if (mathRandomBackup !== null) {
      Math.random = mathRandomBackup;
      mathRandomBackup = null;
    }
    mathRandomBackup = Math.random;
    let state = seed >>> 0;
    Math.random = function batchSeededRandom() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function restoreNativeRandom() {
    if (mathRandomBackup !== null) {
      Math.random = mathRandomBackup;
      mathRandomBackup = null;
    }
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

  function randomIntInclusive(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function pickProfileKey() {
    const roll = Math.random();
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
    console.log("Profiles enabled:", enableProfiles);
    console.table(
      Object.entries(distribution).map(([profileKey, count]) => ({
        profileKey,
        count,
      }))
    );
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
      "prototypeCluster",
      "heuristicCluster",
      "exactAStar",
      "boundedAStar",
      "astarOptimized",
      "tickSearch",
      "rowBinInterleave",
    ]);
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
                    :             mapKey === "exactAStar"
              ? "Exact A*"
              : mapKey === "boundedAStar" || mapKey === "astarOptimized"
                ? "Bounded A*"
                : mapKey === "tickSearch"
                  ? "Tick Search (sampled)"
                  : mapKey === "rowBinInterleave"
                    ? "Row-bin interleave"
                    : mapKey.charAt(0).toUpperCase() + mapKey.slice(1),
          type:
            mapKey === "heuristicCluster" ||
            mapKey === "exactAStar" ||
            mapKey === "boundedAStar" ||
            mapKey === "astarOptimized" ||
            mapKey === "tickSearch"
              ? "optimized"
              : "normal",
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
      entries.push(candidate);
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
    return registry[key] ? registry[key].label : key;
  }

  function algorithmTypeForKey(key) {
    const registry = validatedAlgorithmRegistry;
    return registry[key] ? registry[key].type : "normal";
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

  function createPassengerBlueprints(count, rows, seats) {
    const max = Math.min(count, rows * seats.length);
    const seatPool = [];
    for (let row = 1; row <= rows; row += 1) {
      for (const seat of seats) {
        seatPool.push({ row, seat });
      }
    }

    for (let i = seatPool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = seatPool[i];
      seatPool[i] = seatPool[j];
      seatPool[j] = tmp;
    }

    const passengers = [];
    const enableProfiles = ui.enableProfilesCheckbox.checked;
    const benchmarkMode = ui.benchmarkModeCheckbox.checked;
    const standardProfile = PASSENGER_PROFILES.standard;
    for (let i = 0; i < max; i += 1) {
      const profileKey = benchmarkMode ? "standard" : enableProfiles ? pickProfileKey() : "standard";
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
        stowTime: benchmarkMode ? 10 : randomIntInclusive(profile.stowTimeRange[0], profile.stowTimeRange[1]),
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
      this.algorithmDisplayName = algorithmLabelForKey(this.algorithm);
      this.algorithmRegistry = config.algorithmRegistry || window.BoardingAlgorithms || {};
      this.plane = new Plane(this.rows, this.seats);
      this.tickCount = 0;
      const basePassengerSet = Array.isArray(config.basePassengerSet) ? config.basePassengerSet : null;
      const sourceBlueprints = basePassengerSet || createPassengerBlueprints(this.totalPassengers, this.rows, this.seats);
      this.allPassengers = clonePassengers(sourceBlueprints);
      this.waitingQueue = this.orderPassengers(this.algorithm);
      if (this.algorithm === "exactAStar" && this.totalPassengers > 9) {
        this.algorithmDisplayName = "Exact A* fallback -> Bounded A*";
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
      let strategy = registry[algorithmName];
      if (!strategy || typeof strategy.run !== "function") {
        strategy = registry.random;
      }
      if (!strategy || typeof strategy.run !== "function") {
        return this.allPassengers.slice();
      }
      try {
        const result = strategy.run(this.allPassengers);
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
          const fallback = registry.random.run(this.allPassengers);
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
          totalInterference += randomIntInclusive(SEAT_INTERFERENCE_RANGE[0], SEAT_INTERFERENCE_RANGE[1]);
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

  function shufflePassengerIdOrder(ids) {
    const copy = ids.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
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
  window.__aeroBoardRunTickSearch = function runTickSearchFromPassengers(passengers) {
    if (!Array.isArray(passengers) || passengers.length <= 1) {
      return passengers.slice();
    }
    const registry = validatedAlgorithmRegistry;
    const rows = ROWS;
    const seats = SEATS;
    const totalPassengers = passengers.length;
    const blueprints = blueprintsFromPassengerList(passengers);
    const allIds = passengers.map((p) => p.id);

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
      });
      while (!sim.isFinished()) {
        sim.tick();
      }
      return sim.tickCount;
    }

    let baselineIds = shufflePassengerIdOrder(allIds);
    if (registry.boundedAStar && typeof registry.boundedAStar.run === "function") {
      const boundedSim = new Simulation({
        rows,
        seats,
        totalPassengers,
        algorithm: "boundedAStar",
        algorithmRegistry: registry,
        basePassengerSet: blueprints,
      });
      baselineIds = boundedSim.waitingQueue.map((p) => p.id);
    }

    const randomTrials = Math.min(48, Math.max(20, Math.floor(80 - totalPassengers / 8)));
    let bestIds = baselineIds;
    let bestTicks = evaluateIdOrder(baselineIds);
    for (let t = 0; t < randomTrials; t += 1) {
      const candidateIds = shufflePassengerIdOrder(allIds);
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
        const i = Math.floor(Math.random() * n);
        const j = Math.floor(Math.random() * n);
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
      this.padding = 26;
      this.cellHeight = (canvas.height - this.padding * 2) / this.rows;
      this.seatSize = 16;
      this.seatGap = 9;
      this.aisleWidth = 52;
      this.leftBlockWidth = this.seatSize * 3 + this.seatGap * 2;
      this.passengerDrawPoints = [];
    }

    seatPosition(rowIndex, seatLabel) {
      const y = this.padding + rowIndex * this.cellHeight + this.cellHeight / 2;
      const leftStart = this.padding + 140;
      const aisleX = leftStart + this.leftBlockWidth + 20;
      const rightStart = aisleX + this.aisleWidth + 20;
      const seatOffsets = { A: 0, B: 1, C: 2, D: 0, E: 1, F: 2 };

      if (seatLabel === "A" || seatLabel === "B" || seatLabel === "C") {
        return { x: leftStart + seatOffsets[seatLabel] * (this.seatSize + this.seatGap), y };
      }
      return { x: rightStart + seatOffsets[seatLabel] * (this.seatSize + this.seatGap), y };
    }

    aislePosition(rowIndex) {
      const leftStart = this.padding + 140;
      const aisleX = leftStart + this.leftBlockWidth + 20;
      const y = this.padding + rowIndex * this.cellHeight + this.cellHeight / 2;
      return { x: aisleX + this.aisleWidth / 2, y };
    }

    drawBasePlane() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = "#f1f7ff";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      const leftStart = this.padding + 140;
      const aisleX = leftStart + this.leftBlockWidth + 20;
      const rightStart = aisleX + this.aisleWidth + 20;

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
        ctx.font = "12px Segoe UI";
        ctx.fillText(String(row + 1), this.padding + 90, this.padding + row * this.cellHeight + 4);
      }

      ctx.fillStyle = "#38526b";
      ctx.font = "13px Segoe UI";
      ctx.fillText("A", leftStart - 6, this.padding - 8);
      ctx.fillText("B", leftStart + (this.seatSize + this.seatGap) - 6, this.padding - 8);
      ctx.fillText("C", leftStart + 2 * (this.seatSize + this.seatGap) - 6, this.padding - 8);
      ctx.fillText("D", rightStart - 6, this.padding - 8);
      ctx.fillText("E", rightStart + (this.seatSize + this.seatGap) - 6, this.padding - 8);
      ctx.fillText("F", rightStart + 2 * (this.seatSize + this.seatGap) - 6, this.padding - 8);
    }

    drawPassengerCircle(x, y, passenger) {
      const ctx = this.ctx;
      const radius = 7;
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
      const fontSize = Math.max(8, radius + 2);
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
      for (let i = 0; i < this.simulation.plane.aisle.length; i += 1) {
        const passenger = this.simulation.plane.aisle[i];
        if (passenger) {
          const aislePos = this.aislePosition(i);
          this.drawPassengerCircle(aislePos.x, aislePos.y, passenger);
          this.passengerDrawPoints.push({ x: aislePos.x, y: aislePos.y, radius: 8, passenger });
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
          this.passengerDrawPoints.push({ x: seatPos.x, y: seatPos.y, radius: 8, passenger });
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
    };
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
      return;
    }
    setAlgorithmUiEnabled(true);

    function appendAlgorithmPill(container, item) {
      const div = document.createElement("div");
      div.className = `algorithm-pill ${item.type === "optimized" ? "optimized" : ""}`;
      div.textContent = item.label;
      container.appendChild(div);
    }

    function appendComparisonCheckbox(container, item, checked) {
      const label = document.createElement("label");
      label.className = "algorithm-checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = item.key;
      checkbox.checked = checked;
      checkbox.dataset.algorithmKey = item.key;
      const text = document.createElement("span");
      text.textContent = item.label;
      const typeBadge = document.createElement("span");
      typeBadge.className = `algo-type-badge ${item.type === "optimized" ? "optimized" : ""}`;
      typeBadge.textContent = item.type === "optimized" ? "Optimiert" : "Normal";
      label.appendChild(checkbox);
      label.appendChild(text);
      label.appendChild(typeBadge);
      container.appendChild(label);
    }

    for (const item of metadata) {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = item.label;
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
    for (const key of selectedKeys) {
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

  function createComparisonRowHtml(entry, isWinner) {
    const status = entry.finished ? "Fertig" : "Laeuft";
    const typeLabel = entry.algorithmType === "optimized" ? "Optimiert" : "Normal";
    const progress = entry.totalPassengers <= 0 ? 0 : Math.min(100, Math.round((entry.seatedCount / entry.totalPassengers) * 100));
    const m = entry.metrics || emptyMetricsSnapshot();
    const dash = "—";
    const num = (v) => (Number.isFinite(v) ? String(Math.round(v)) : dash);
    const num1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : dash);
    return `<tr class="${isWinner ? "winner" : ""}"><td>${entry.algorithmLabel}</td><td>${typeLabel}</td><td>${status}</td><td>${entry.tickCount}</td><td>${entry.waitingCount}</td><td>${entry.aisleCount}</td><td>${entry.seatedCount}</td><td>${progress}%</td><td>${num(m.totalStowingTicks)}</td><td>${num(m.totalSeatingTicks)}</td><td>${num(m.walkingBlockedTicks)}</td><td>${num(m.spawnBlockedTicks)}</td><td>${num(m.maxAisleOccupancy)}</td><td>${num1(m.avgQueueDelayTicks)}</td></tr>`;
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
      this.currentSim = null;
      this.runTickByKey = null;
      this.tickSamples = new Map();
      this.wins = new Map();
      this.runsCompleted = 0;
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
    }

    renderTable() {
      if (this.selectedKeys.length === 0) {
        this.ui.batchComparisonTableBody.innerHTML =
          '<tr><td colspan="15" class="empty-row">Noch kein Batch-Vergleich gestartet.</td></tr>';
        return;
      }
      const hasData = this.selectedKeys.some((k) => (this.tickSamples.get(k) || []).length > 0);
      if (!this.running && !hasData) {
        this.ui.batchComparisonTableBody.innerHTML =
          '<tr><td colspan="15" class="empty-row">Noch kein Batch-Vergleich gestartet.</td></tr>';
        return;
      }

      const runs = this.runsCompleted;
      const rows = this.selectedKeys.map((key) => {
        const samples = this.tickSamples.get(key) || [];
        const n = samples.length;
        const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
        const std = sampleStandardDeviation(samples);
        const min = n > 0 ? Math.min(...samples) : 0;
        const max = n > 0 ? Math.max(...samples) : 0;
        const w = this.wins.get(key) || 0;
        const winRate = runs > 0 ? (100 * w) / runs : 0;
        const typeLabel = algorithmTypeForKey(key) === "optimized" ? "Optimiert" : "Normal";
        const label = algorithmLabelForKey(key);
        const ms = this.metricSamples.get(key) || [];
        const fmt = (v) => (v === null ? "—" : v.toFixed(0));
        const mStow = meanMetricSeries(ms, "totalStowingTicks");
        const mSeat = meanMetricSeries(ms, "totalSeatingTicks");
        const mSpawn = meanMetricSeries(ms, "spawnBlockedTicks");
        const mQ = meanMetricSeries(ms, "avgQueueDelayTicks");
        return `<tr><td>${label}</td><td>${typeLabel}</td><td>${runs}</td><td>${mean.toFixed(1)}</td><td>${std.toFixed(2)}</td><td>${min}</td><td>${max}</td><td>${w}</td><td>${winRate.toFixed(1)}%</td><td>${fmt(mStow)}</td><td>${fmt(mSeat)}</td><td>${fmt(mSpawn)}</td><td>${fmt(mQ)}</td></tr>`;
      });
      this.ui.batchComparisonTableBody.innerHTML = rows.join("");
    }

    schedule(fn) {
      this.timeoutId = setTimeout(fn, 0);
    }

    finishBatch(aborted) {
      restoreNativeRandom();
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
      this.currentSim = null;
      this.runTickByKey = null;
      this.runsCompleted = 0;
      this.tickSamples = new Map(keys.map((k) => [k, []]));
      this.metricSamples = new Map(keys.map((k) => [k, []]));
      this.wins = new Map(keys.map((k) => [k, 0]));

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

      const blueprintSeed = AEROBOARD_BATCH_BASE_SEED + this.runIndex;
      installSeededRandom(blueprintSeed);
      let baseSet;
      try {
        const config = getSimulationConfigFromUi();
        baseSet = createPassengerBlueprints(config.totalPassengers, config.rows, config.seats);
      } finally {
        restoreNativeRandom();
      }

      this.currentBlueprint = baseSet;
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
      const blueprintSeed = AEROBOARD_BATCH_BASE_SEED + this.runIndex;
      const simSeed = mixSimulationSeed(blueprintSeed, algorithmKey);

      installSeededRandom(simSeed);
      try {
        const config = getSimulationConfigFromUi();
        this.currentSim = new Simulation({
          rows: config.rows,
          seats: config.seats,
          totalPassengers: config.totalPassengers,
          algorithm: algorithmKey,
          algorithmRegistry: validatedAlgorithmRegistry,
          basePassengerSet: this.currentBlueprint,
        });
      } catch (err) {
        restoreNativeRandom();
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
        restoreNativeRandom();
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
        restoreNativeRandom();
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
      this.ui.tickStat.textContent = String(this.simulation.tickCount);
      this.ui.waitingStat.textContent = String(stats.waiting);
      this.ui.aisleStat.textContent = String(stats.aisle);
      this.ui.seatedStat.textContent = String(stats.seated);
      this.ui.algorithmStat.textContent = this.simulation.algorithmDisplayName || algorithmLabelForKey(this.simulation.algorithm);
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
      this.simulations = [];
      this.renderTable();
    }

    ensureSimulations() {
      const selected = this.getSelectedAlgorithmKeys();
      if (selected.length === 0) {
        this.renderTable();
        return false;
      }

      if (!this.basePassengerSet) {
        const config = getSimulationConfigFromUi();
        this.basePassengerSet = createPassengerBlueprints(config.totalPassengers, config.rows, config.seats);
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
        return;
      }

      const allFinished = rows.every((row) => row.finished);
      const sortedRows = allFinished ? rows.slice().sort((a, b) => a.tickCount - b.tickCount) : rows;
      const winnerKey = allFinished && sortedRows.length > 0 ? sortedRows[0].algorithmKey : null;
      this.ui.comparisonTableBody.innerHTML = sortedRows
        .map((row) => createComparisonRowHtml(row, winnerKey !== null && row.algorithmKey === winnerKey))
        .join("");
    }
  }

  let singleController = null;
  let comparisonController = null;
  let batchComparisonController = null;

  if (!validateUiRefs(ui)) {
    return;
  }
  console.log("Loaded BoardingAlgorithms:", Object.keys(window.BoardingAlgorithms || {}));
  renderAlgorithmControls();
  updateProfilesStatusBadge();
  singleController = new SingleSimulationController(ui);
  comparisonController = new ComparisonController(ui);
  batchComparisonController = new BatchComparisonController(ui);

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
  ui.comparisonStartButton.addEventListener("click", () => comparisonController.start());
  ui.comparisonResetButton.addEventListener("click", () => comparisonController.reset());
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
    ui.algorithmStat.textContent = "-";
  } else {
    singleController.reset();
  }
  comparisonController.renderTable();
  batchComparisonController.renderTable();
})();
