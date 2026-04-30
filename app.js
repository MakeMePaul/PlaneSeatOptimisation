(function runAeroBoard() {
  "use strict";

  const ROWS = 30;
  const SEATS = ["A", "B", "C", "D", "E", "F"];
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
  };

  const PASSENGER_PROFILES = {
    business: {
      label: "Business",
      probability: 0.15,
      stowTimeRange: [3, 8],
      moveCooldown: 0,
    },
    standard: {
      label: "Standard",
      probability: 0.5,
      stowTimeRange: [6, 14],
      moveCooldown: 0,
    },
    elderly: {
      label: "Aeltere Person",
      probability: 0.1,
      stowTimeRange: [10, 22],
      moveCooldown: 1,
    },
    child: {
      label: "Kind",
      probability: 0.1,
      stowTimeRange: [8, 18],
      moveCooldown: 1,
    },
    heavy_luggage: {
      label: "Viel Gepaeck",
      probability: 0.15,
      stowTimeRange: [15, 30],
      moveCooldown: 0,
    },
  };

  const PROFILE_KEYS = Object.keys(PASSENGER_PROFILES);
  const SEAT_INTERFERENCE_RANGE = [3, 8];

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

  function randomIntInclusive(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function resolveClusterColor(clusterId) {
    return CLUSTER_COLORS[clusterId] || "#8a96a1";
  }

  function clusterIdForAlgorithm(targetSeat, algorithmKey) {
    const row = targetSeat.row;
    const seat = targetSeat.seat;

    if (algorithmKey === "backToFront") {
      if (row >= 21) {
        return "zone_back";
      }
      if (row >= 11) {
        return "zone_middle";
      }
      return "zone_front";
    }

    if (algorithmKey === "windowMiddleAisle") {
      if (seat === "A" || seat === "F") {
        return "window";
      }
      if (seat === "B" || seat === "E") {
        return "middle";
      }
      return "aisle";
    }

    if (algorithmKey === "prototypeCluster") {
      if (row <= 8) {
        return "cluster_1";
      }
      if (row <= 16) {
        return "cluster_2";
      }
      if (row <= 24) {
        return "cluster_3";
      }
      return "cluster_4";
    }

    return "random";
  }

  function assignClustersForAlgorithm(passengers, algorithmKey) {
    for (const passenger of passengers) {
      const clusterId = clusterIdForAlgorithm(passenger.targetSeat, algorithmKey);
      passenger.clusterId = clusterId;
      passenger.color = resolveClusterColor(clusterId);
    }
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
    }
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
      this.enableProfiles = config.enableProfiles;
      this.plane = new Plane(this.rows, this.seats);
      this.tickCount = 0;
      this.allPassengers = this.createPassengers(this.totalPassengers, this.enableProfiles);
      assignClustersForAlgorithm(this.allPassengers, this.algorithm);
      this.waitingQueue = this.orderPassengers(this.algorithm);
      this.running = false;
    }

    createPassengers(count, enableProfiles) {
      const max = Math.min(count, this.rows * this.seats.length);
      const seatPool = [];
      for (let row = 1; row <= this.rows; row += 1) {
        for (const seat of this.seats) {
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
      const standardProfile = PASSENGER_PROFILES.standard;
      for (let i = 0; i < max; i += 1) {
        const profileKey = enableProfiles ? pickProfileKey() : "standard";
        const profile = enableProfiles ? PASSENGER_PROFILES[profileKey] : standardProfile;
        const stowTime = randomIntInclusive(profile.stowTimeRange[0], profile.stowTimeRange[1]);

        passengers.push(
          new Passenger({
            id: i + 1,
            targetSeat: seatPool[i],
            stowTime,
            groupId: null,
            clusterId: "random",
            color: resolveClusterColor("random"),
            profileKey,
            profileLabel: profile.label,
            moveCooldown: profile.moveCooldown,
          })
        );
      }
      return passengers;
    }

    orderPassengers(algorithmName) {
      const algorithms = window.BoardingAlgorithms || {};
      let strategy = algorithms[algorithmName];

      if (typeof strategy !== "function") {
        if (typeof algorithms.random === "function") {
          console.warn(`Boarding algorithm "${algorithmName}" missing. Falling back to "random".`);
          strategy = algorithms.random;
        } else {
          console.warn('Boarding algorithm registry missing or invalid. Falling back to unsorted passenger list.');
          strategy = (passengers) => passengers.slice();
        }
      }
      return strategy(this.allPassengers);
    }

    spawnPassenger() {
      if (this.waitingQueue.length === 0) {
        return;
      }
      if (!this.plane.isAisleFree(0)) {
        return;
      }

      const passenger = this.waitingQueue.shift();
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
        }
      }
    }

    tick() {
      this.tickCount += 1;
      this.updateStowing();
      this.moveWalkingPassengers();
      this.spawnPassenger();
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
      ctx.beginPath();
      ctx.fillStyle = passenger.color;
      ctx.arc(x, y, 7, 0, Math.PI * 2);
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
          this.ctx.fillStyle = "#ffffff";
          this.ctx.font = "9px Segoe UI";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.fillText(String(passenger.id), seatPos.x, seatPos.y);
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
    passengerCountInput: document.getElementById("passengerCountInput"),
    speedInput: document.getElementById("speedInput"),
    enableProfilesCheckbox: document.getElementById("enableProfilesCheckbox"),
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

  let simulation = null;
  let renderer = null;
  let timerId = null;

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
    if (!renderer || !simulation) {
      hideTooltip();
      return;
    }
    const rect = ui.canvas.getBoundingClientRect();
    const scaleX = ui.canvas.width / rect.width;
    const scaleY = ui.canvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;
    const passenger = renderer.findPassengerAt(canvasX, canvasY);

    if (!passenger) {
      hideTooltip();
      return;
    }
    showTooltip(passenger, event.clientX, event.clientY);
  }

  function getSimulationConfigFromUi() {
    const requestedPassengers = Number(ui.passengerCountInput.value) || 60;
    const boundedPassengers = Math.max(1, Math.min(180, requestedPassengers));
    ui.passengerCountInput.value = String(boundedPassengers);

    return {
      rows: ROWS,
      seats: SEATS,
      totalPassengers: boundedPassengers,
      algorithm: ui.algorithmSelect.value,
      enableProfiles: ui.enableProfilesCheckbox.checked,
    };
  }

  function resetSimulation() {
    if (!ui.canvas) {
      return;
    }
    simulation = new Simulation(getSimulationConfigFromUi());
    renderer = new Renderer(ui.canvas, simulation);
    updateStats();
    renderer.render();
  }

  function updateStats() {
    if (!simulation) {
      return;
    }
    const stats = simulation.counts();
    ui.tickStat.textContent = String(simulation.tickCount);
    ui.waitingStat.textContent = String(stats.waiting);
    ui.aisleStat.textContent = String(stats.aisle);
    ui.seatedStat.textContent = String(stats.seated);
    ui.algorithmStat.textContent = ui.algorithmSelect.options[ui.algorithmSelect.selectedIndex].text;
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
      passengerCountInput: "passengerCountInput",
      speedInput: "speedInput",
      enableProfilesCheckbox: "enableProfilesCheckbox",
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

  function stopTimer() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    if (simulation) {
      simulation.running = false;
    }
  }

  function executeTick() {
    if (simulation.isFinished()) {
      stopTimer();
      return;
    }
    simulation.tick();
    updateStats();
    renderer.render();
    if (simulation.isFinished()) {
      stopTimer();
    }
  }

  function startSimulation() {
    stopTimer();
    simulation.running = true;
    const interval = Math.max(50, Number(ui.speedInput.value) || 350);
    ui.speedInput.value = String(interval);
    timerId = setInterval(executeTick, interval);
  }

  if (!validateUiRefs(ui)) {
    return;
  }

  ui.startButton.addEventListener("click", startSimulation);
  ui.pauseButton.addEventListener("click", stopTimer);
  ui.tickButton.addEventListener("click", () => {
    stopTimer();
    executeTick();
  });
  ui.resetButton.addEventListener("click", () => {
    stopTimer();
    hideTooltip();
    resetSimulation();
  });
  ui.algorithmSelect.addEventListener("change", () => {
    stopTimer();
    hideTooltip();
    resetSimulation();
  });
  ui.speedInput.addEventListener("input", () => {
    const interval = Math.max(50, Number(ui.speedInput.value) || 350);
    ui.speedInput.value = String(interval);
    if (simulation && simulation.running && timerId !== null) {
      startSimulation();
    }
  });
  ui.enableProfilesCheckbox.addEventListener("change", () => {
    stopTimer();
    hideTooltip();
    resetSimulation();
  });
  ui.canvas.addEventListener("mousemove", onCanvasPointerMove);
  ui.canvas.addEventListener("mouseleave", hideTooltip);

  resetSimulation();
})();
