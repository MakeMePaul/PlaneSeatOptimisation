(function attachAlgorithms(globalScope) {
  "use strict";

  const MAX_EXACT_ASTAR_PASSENGERS = 9;
  const BOUNDED_MAX_EXPANDED_NODES = 5000;
  const BOUNDED_MAX_BRANCHING_CANDIDATES = 10;
  const BOUNDED_MAX_OPEN_SET_SIZE = 300;

  function randomOrder(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function groupPassengersForBoarding(passengers) {
    const groupsByKey = new Map();
    const groups = [];
    let singleCounter = 0;

    for (const passenger of passengers) {
      const hasGroupId = passenger.groupId !== null && passenger.groupId !== undefined;
      const key = hasGroupId ? `group:${String(passenger.groupId)}` : `single:${singleCounter++}`;

      if (!groupsByKey.has(key)) {
        const group = {
          key,
          groupId: hasGroupId ? passenger.groupId : null,
          passengers: [],
          size: 0,
          avgTargetRow: 0,
          maxTargetRow: 0,
          minTargetRow: 0,
        };
        groupsByKey.set(key, group);
        groups.push(group);
      }

      groupsByKey.get(key).passengers.push(passenger);
    }

    for (const group of groups) {
      let sum = 0;
      let max = -Infinity;
      let min = Infinity;
      for (const passenger of group.passengers) {
        const row = passenger.targetSeat.row;
        sum += row;
        if (row > max) {
          max = row;
        }
        if (row < min) {
          min = row;
        }
      }
      group.size = group.passengers.length;
      group.avgTargetRow = sum / group.size;
      group.maxTargetRow = max;
      group.minTargetRow = min;
    }

    return groups;
  }

  function flattenGroupedPassengers(groups) {
    const flat = [];
    for (const group of groups) {
      for (const passenger of group.passengers) {
        flat.push(passenger);
      }
    }
    return flat;
  }

  function stableGroupId(group) {
    if (group.groupId !== null && group.groupId !== undefined) {
      return `group:${String(group.groupId)}`;
    }
    return group.key;
  }

  function stablePassengerId(group) {
    return group.passengers.length > 0 ? group.passengers[0].id : Number.MAX_SAFE_INTEGER;
  }

  function stableGroupCompare(a, b) {
    const idA = stableGroupId(a);
    const idB = stableGroupId(b);
    if (idA !== idB) {
      return idA < idB ? -1 : 1;
    }
    return stablePassengerId(a) - stablePassengerId(b);
  }

  function backToFront(passengers) {
    const groups = randomOrder(groupPassengersForBoarding(passengers));
    groups.sort((a, b) => b.maxTargetRow - a.maxTargetRow);
    return flattenGroupedPassengers(groups);
  }

  function seatType(seatLabel) {
    if (seatLabel === "A" || seatLabel === "F") {
      return 0; // window
    }
    if (seatLabel === "B" || seatLabel === "E") {
      return 1; // middle
    }
    return 2; // aisle (C/D)
  }

  function zonePriorityForRow(row) {
    if (row >= 21) {
      return 0; // rear
    }
    if (row >= 11) {
      return 1; // middle
    }
    return 2; // front
  }

  function groupSeatTypePriority(group) {
    let best = 2;
    for (const passenger of group.passengers) {
      const type = seatType(passenger.targetSeat.seat);
      if (type < best) {
        best = type;
      }
      if (best === 0) {
        break;
      }
    }
    return best;
  }

  function windowMiddleAisle(passengers) {
    const groups = groupPassengersForBoarding(passengers);
    groups.sort((a, b) => {
      const zoneA = zonePriorityForRow(a.maxTargetRow);
      const zoneB = zonePriorityForRow(b.maxTargetRow);
      if (zoneA !== zoneB) {
        return zoneA - zoneB;
      }

      const typeA = groupSeatTypePriority(a);
      const typeB = groupSeatTypePriority(b);
      if (typeA !== typeB) {
        return typeA - typeB;
      }

      const rowDiff = b.maxTargetRow - a.maxTargetRow;
      if (rowDiff !== 0) {
        return rowDiff;
      }

      return stableGroupCompare(a, b);
    });
    return flattenGroupedPassengers(groups);
  }

  function getSteffenSeatGroup(seat) {
    if (seat === "A" || seat === "F") {
      return "window";
    }
    if (seat === "B" || seat === "E") {
      return "middle";
    }
    return "aisle";
  }

  function getSteffenSeatGroupPriority(seat) {
    if (seat === "A" || seat === "F") {
      return 0;
    }
    if (seat === "B" || seat === "E") {
      return 1;
    }
    return 2;
  }

  function getRowParityPriority(row) {
    if (!Number.isFinite(row)) {
      return 1;
    }
    const r = Math.trunc(row);
    return r % 2 === 1 ? 0 : 1;
  }

  function getSteffenSeatTieBreaker(seat) {
    if (seat === "A") {
      return 0;
    }
    if (seat === "F") {
      return 1;
    }
    if (seat === "B") {
      return 2;
    }
    if (seat === "E") {
      return 3;
    }
    if (seat === "C") {
      return 4;
    }
    if (seat === "D") {
      return 5;
    }
    return 6;
  }

  function groupSteffenSeatGroupPriority(group) {
    let best = 3;
    for (const passenger of group.passengers) {
      const v = getSteffenSeatGroupPriority(passenger.targetSeat.seat);
      if (v < best) {
        best = v;
      }
      if (best === 0) {
        break;
      }
    }
    return best;
  }

  function groupSteffenRowTieKey(group, seatGroupPri) {
    const maxR = group.maxTargetRow;
    let best = Number.MAX_SAFE_INTEGER;
    let found = false;
    for (const passenger of group.passengers) {
      if (passenger.targetSeat.row !== maxR) {
        continue;
      }
      if (getSteffenSeatGroupPriority(passenger.targetSeat.seat) !== seatGroupPri) {
        continue;
      }
      found = true;
      const t = getSteffenSeatTieBreaker(passenger.targetSeat.seat);
      if (t < best) {
        best = t;
      }
    }
    if (found) {
      return best;
    }
    best = Number.MAX_SAFE_INTEGER;
    for (const passenger of group.passengers) {
      if (passenger.targetSeat.row !== maxR) {
        continue;
      }
      const t = getSteffenSeatTieBreaker(passenger.targetSeat.seat);
      if (t < best) {
        best = t;
      }
    }
    return best === Number.MAX_SAFE_INTEGER ? 0 : best;
  }

  function minPassengerIdInGroup(group) {
    let min = Number.MAX_SAFE_INTEGER;
    for (const passenger of group.passengers) {
      const n = numericPassengerId(passenger);
      if (n < min) {
        min = n;
      }
    }
    return min;
  }

  function steffenDeterministic(passengers) {
    const groups = groupPassengersForBoarding(passengers);
    groups.sort((a, b) => {
      const sgA = groupSteffenSeatGroupPriority(a);
      const sgB = groupSteffenSeatGroupPriority(b);
      if (sgA !== sgB) {
        return sgA - sgB;
      }

      const rpA = getRowParityPriority(a.maxTargetRow);
      const rpB = getRowParityPriority(b.maxTargetRow);
      if (rpA !== rpB) {
        return rpA - rpB;
      }

      const rowDiff = b.maxTargetRow - a.maxTargetRow;
      if (rowDiff !== 0) {
        return rowDiff;
      }

      const tieA = groupSteffenRowTieKey(a, sgA);
      const tieB = groupSteffenRowTieKey(b, sgB);
      if (tieA !== tieB) {
        return tieA - tieB;
      }

      const idA = minPassengerIdInGroup(a);
      const idB = minPassengerIdInGroup(b);
      if (idA !== idB) {
        return idA - idB;
      }

      return stableGroupCompare(a, b);
    });
    return flattenGroupedPassengers(groups);
  }

  function prototypeCluster(passengers) {
    // Lower numeric priority boards first: rear clusters (cluster_4) before front (cluster_1).
    const clusterPriority = {
      cluster_1: 4,
      cluster_2: 3,
      cluster_3: 2,
      cluster_4: 1,
    };
    const groups = randomOrder(groupPassengersForBoarding(passengers));
    groups.sort((a, b) => {
      const sampleA = a.passengers[0];
      const sampleB = b.passengers[0];
      const priorityA = clusterPriority[sampleA.clusterId] || Number.MAX_SAFE_INTEGER;
      const priorityB = clusterPriority[sampleB.clusterId] || Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      return b.maxTargetRow - a.maxTargetRow;
    });
    return flattenGroupedPassengers(groups);
  }

  function profilePenalty(profileKey) {
    if (profileKey === "heavy_luggage") {
      return 2.2;
    }
    if (profileKey === "elderly") {
      return 1.8;
    }
    if (profileKey === "child") {
      return 1.4;
    }
    return 0;
  }

  function seatPriorityValue(seatLabel) {
    if (seatLabel === "A" || seatLabel === "F") {
      return 0; // window
    }
    if (seatLabel === "B" || seatLabel === "E") {
      return 1; // middle
    }
    return 2; // aisle
  }

  function enrichGroupMetrics(groups) {
    for (const group of groups) {
      let stowSum = 0;
      let seatPrioritySum = 0;
      let slowProfilePenalty = 0;
      for (const passenger of group.passengers) {
        stowSum += passenger.stowTime || 0;
        seatPrioritySum += seatPriorityValue(passenger.targetSeat.seat);
        slowProfilePenalty += profilePenalty(passenger.profileKey);
      }
      group.avgStowTime = stowSum / group.size;
      group.avgSeatPriority = seatPrioritySum / group.size;
      group.slowProfilePenalty = slowProfilePenalty;
    }
    return groups;
  }

  function preliminaryGroupPriority(group) {
    const rowPriority = group.avgTargetRow * 1.9;
    const seatPriority = (2 - group.avgSeatPriority) * 1.4; // window/middle before aisle
    const stowPriority = group.avgStowTime * 0.35;
    const profilePriority = group.slowProfilePenalty * 0.55;
    const sizePriority = group.size * 0.45;
    return rowPriority + seatPriority + stowPriority + profilePriority + sizePriority;
  }

  function heuristicClusterOrder(groups) {
    const copy = groups.slice();
    copy.sort((a, b) => {
      const scoreDiff = preliminaryGroupPriority(b) - preliminaryGroupPriority(a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return stableGroupCompare(a, b);
    });
    return copy;
  }

  function heuristicCluster(passengers) {
    const grouped = enrichGroupMetrics(groupPassengersForBoarding(passengers));
    const orderedGroups = heuristicClusterOrder(grouped);
    return flattenGroupedPassengers(orderedGroups);
  }

  function numericPassengerId(passenger) {
    const asNumber = Number(passenger.id);
    return Number.isFinite(asNumber) ? asNumber : Number.MAX_SAFE_INTEGER;
  }

  function stablePassengerCompare(a, b) {
    const idDiff = numericPassengerId(a) - numericPassengerId(b);
    if (idDiff !== 0) {
      return idDiff;
    }
    if (a.targetSeat.row !== b.targetSeat.row) {
      return b.targetSeat.row - a.targetSeat.row;
    }
    const seatDiff = getSeatTypePriority(a.targetSeat.seat) - getSeatTypePriority(b.targetSeat.seat);
    if (seatDiff !== 0) {
      return seatDiff;
    }
    return String(a.id).localeCompare(String(b.id));
  }

  function getSeatTypePriority(seat) {
    if (seat === "A" || seat === "F") {
      return 0;
    }
    if (seat === "B" || seat === "E") {
      return 1;
    }
    return 2;
  }

  function getPassengerRiskScore(passenger) {
    let risk = 0;
    if (passenger.profileKey === "heavy_luggage") {
      risk += 2.6;
    } else if (passenger.profileKey === "elderly") {
      risk += 2.0;
    } else if (passenger.profileKey === "child") {
      risk += 1.4;
    } else if (passenger.profileKey === "business") {
      risk -= 0.5;
    }
    risk += (passenger.stowTime || 0) * 0.08;
    return risk;
  }

  function preliminaryPassengerPriority(passenger, positionIndex) {
    const rowScore = passenger.targetSeat.row * (2.0 + positionIndex * 0.01);
    const seatScore = (2 - getSeatTypePriority(passenger.targetSeat.seat)) * 1.45;
    const stowBoost = (passenger.stowTime || 0) * Math.max(0.06, 0.22 - positionIndex * 0.003);
    const riskScore = getPassengerRiskScore(passenger);
    const riskBoost = Math.max(0, riskScore) * Math.max(0.08, 0.28 - positionIndex * 0.004);
    return rowScore + seatScore + stowBoost + riskBoost;
  }

  function estimateBoardingConflictCost(lastPassenger, nextPassenger, positionIndex) {
    if (!lastPassenger || !nextPassenger) {
      return 0;
    }

    const rowDistance = Math.abs(lastPassenger.targetSeat.row - nextPassenger.targetSeat.row);
    const closeRowPenalty = rowDistance <= 1 ? 1.1 : rowDistance <= 2 ? 0.5 : 0;

    const stowLoad = ((lastPassenger.stowTime || 0) + (nextPassenger.stowTime || 0)) * 0.055;
    const stowClusterPenalty = rowDistance <= 2 ? stowLoad : 0;

    const bothRearRows = lastPassenger.targetSeat.row >= 21 && nextPassenger.targetSeat.row >= 21;
    const longRearSequencePenalty = bothRearRows ? Math.min(1.0, 0.18 + positionIndex * 0.015) : 0;

    return closeRowPenalty + stowClusterPenalty + longRearSequencePenalty;
  }

  function transitionCost(lastPassenger, nextPassenger, positionIndex) {
    const row = nextPassenger.targetSeat.row;
    const rearPenalty = (31 - row) * (0.35 + positionIndex * 0.045);
    const frontTooEarlyPenalty = row <= 8 ? 1.2 : row <= 15 ? 0.45 : 0;
    const seatTypePenalty = getSeatTypePriority(nextPassenger.targetSeat.seat) * (0.9 + positionIndex * 0.03);
    const stowPenalty = (nextPassenger.stowTime || 0) * (0.17 + positionIndex * 0.008);
    const riskPenalty = getPassengerRiskScore(nextPassenger) * (0.6 + positionIndex * 0.01);
    const rowSwitchPenalty = lastPassenger
      ? Math.abs(lastPassenger.targetSeat.row - nextPassenger.targetSeat.row) * 0.12
      : 0;
    const conflictPenalty = estimateBoardingConflictCost(lastPassenger, nextPassenger, positionIndex);

    return rearPenalty + frontTooEarlyPenalty + seatTypePenalty + stowPenalty + riskPenalty + rowSwitchPenalty + conflictPenalty;
  }

  function estimateRemainingCost(remainingIds, passengersById, positionIndex) {
    if (remainingIds.length === 0) {
      return 0;
    }

    let total = 0;
    for (const id of remainingIds) {
      const passenger = passengersById.get(id);
      if (!passenger) {
        continue;
      }
      total += (31 - passenger.targetSeat.row) * 0.2;
      total += getSeatTypePriority(passenger.targetSeat.seat) * 0.3;
      total += (passenger.stowTime || 0) * 0.05;
      total += Math.max(0, getPassengerRiskScore(passenger) * 0.08);
    }
    return total + remainingIds.length * 0.04 + positionIndex * 0.03;
  }

  function exactAStar(passengers) {
    if (!Array.isArray(passengers) || passengers.length <= 1) {
      return passengers.slice();
    }

    if (passengers.length > MAX_EXACT_ASTAR_PASSENGERS) {
      console.warn(
        `Exact A* supports at most ${MAX_EXACT_ASTAR_PASSENGERS} passengers. ` +
          `Received ${passengers.length}. Falling back to Bounded A*.`
      );
      return boundedAStar(passengers);
    }

    const sortedPassengers = passengers.slice().sort(stablePassengerCompare);
    const passengersById = new Map();
    const allPassengerIds = [];
    for (const passenger of sortedPassengers) {
      passengersById.set(passenger.id, passenger);
      allPassengerIds.push(passenger.id);
    }

    function nodePriorityCompare(a, b) {
      if (a.fCost !== b.fCost) {
        return a.fCost - b.fCost;
      }
      if (a.hCost !== b.hCost) {
        return a.hCost - b.hCost;
      }
      if (a.lastPassengerId !== null && b.lastPassengerId !== null && a.lastPassengerId !== b.lastPassengerId) {
        return a.lastPassengerId - b.lastPassengerId;
      }
      return a.orderedPassengerIds.length - b.orderedPassengerIds.length;
    }

    function stateKey(remainingIds, lastPassengerId) {
      return `${remainingIds.join(",")}|${lastPassengerId === null ? "n" : String(lastPassengerId)}`;
    }

    const initialNode = {
      orderedPassengerIds: [],
      remainingPassengerIds: allPassengerIds.slice(),
      gCost: 0,
      hCost: estimateRemainingCost(allPassengerIds, passengersById, 0),
      fCost: 0,
      lastPassengerId: null,
    };
    initialNode.fCost = initialNode.gCost + initialNode.hCost;

    const openSet = [initialNode];
    const bestKnownGCost = new Map();
    bestKnownGCost.set(stateKey(initialNode.remainingPassengerIds, initialNode.lastPassengerId), 0);

    while (openSet.length > 0) {
      openSet.sort(nodePriorityCompare);
      const current = openSet.shift();
      if (!current) {
        break;
      }

      if (current.remainingPassengerIds.length === 0) {
        return current.orderedPassengerIds.map((id) => passengersById.get(id)).filter(Boolean);
      }

      const positionIndex = current.orderedPassengerIds.length;
      const lastPassenger =
        current.lastPassengerId !== null && passengersById.has(current.lastPassengerId)
          ? passengersById.get(current.lastPassengerId)
          : null;

      const sortedCandidates = current.remainingPassengerIds.slice().sort((a, b) => {
        const passengerA = passengersById.get(a);
        const passengerB = passengersById.get(b);
        const scoreA = passengerA ? preliminaryPassengerPriority(passengerA, positionIndex) : -Infinity;
        const scoreB = passengerB ? preliminaryPassengerPriority(passengerB, positionIndex) : -Infinity;
        if (scoreA !== scoreB) {
          return scoreB - scoreA;
        }
        return a - b;
      });

      for (const candidateId of sortedCandidates) {
        const nextPassenger = passengersById.get(candidateId);
        if (!nextPassenger) {
          continue;
        }

        const nextOrdered = current.orderedPassengerIds.concat(candidateId);
        const nextRemaining = current.remainingPassengerIds.filter((id) => id !== candidateId);
        const gCost = current.gCost + transitionCost(lastPassenger, nextPassenger, positionIndex);
        const hCost = estimateRemainingCost(nextRemaining, passengersById, nextOrdered.length);
        const key = stateKey(nextRemaining, candidateId);
        const knownG = bestKnownGCost.get(key);

        if (knownG !== undefined && gCost >= knownG) {
          continue;
        }

        bestKnownGCost.set(key, gCost);
        openSet.push({
          orderedPassengerIds: nextOrdered,
          remainingPassengerIds: nextRemaining,
          gCost,
          hCost,
          fCost: gCost + hCost,
          lastPassengerId: candidateId,
        });
      }
    }

    return sortedPassengers;
  }

  function boundedAStar(passengers) {
    if (!Array.isArray(passengers) || passengers.length <= 1) {
      return passengers.slice();
    }

    const sortedPassengers = passengers.slice().sort(stablePassengerCompare);
    const passengersById = new Map();
    const allPassengerIds = [];
    for (const passenger of sortedPassengers) {
      passengersById.set(passenger.id, passenger);
      allPassengerIds.push(passenger.id);
    }

    if (allPassengerIds.length <= 1) {
      return allPassengerIds.map((id) => passengersById.get(id)).filter(Boolean);
    }

    function nodePriorityCompare(a, b) {
      if (a.fCost !== b.fCost) {
        return a.fCost - b.fCost;
      }
      if (a.hCost !== b.hCost) {
        return a.hCost - b.hCost;
      }
      if (a.lastPassengerId !== null && b.lastPassengerId !== null && a.lastPassengerId !== b.lastPassengerId) {
        return a.lastPassengerId - b.lastPassengerId;
      }
      return a.orderedPassengerIds.length - b.orderedPassengerIds.length;
    }

    function partialNodeScore(node) {
      return node.gCost + node.hCost + node.remainingPassengerIds.length * 0.25;
    }

    function deterministicTailOrder(remainingIds, positionIndexBase) {
      return remainingIds
        .slice()
        .sort((a, b) => {
          const passengerA = passengersById.get(a);
          const passengerB = passengersById.get(b);
          const scoreA = passengerA ? preliminaryPassengerPriority(passengerA, positionIndexBase) : -Infinity;
          const scoreB = passengerB ? preliminaryPassengerPriority(passengerB, positionIndexBase) : -Infinity;
          if (scoreA !== scoreB) {
            return scoreB - scoreA;
          }
          return a - b;
        });
    }

    const initialNode = {
      orderedPassengerIds: [],
      remainingPassengerIds: allPassengerIds.slice(),
      gCost: 0,
      hCost: estimateRemainingCost(allPassengerIds, passengersById, 0),
      fCost: 0,
      lastPassengerId: null,
    };
    initialNode.fCost = initialNode.gCost + initialNode.hCost;

    const openSet = [initialNode];
    let bestPartialNode = initialNode;
    let expandedNodes = 0;

    // Approximated A*: bounded search budget and beam-like candidate pruning.
    while (openSet.length > 0 && expandedNodes < BOUNDED_MAX_EXPANDED_NODES) {
      openSet.sort(nodePriorityCompare);
      const current = openSet.shift();
      if (!current) {
        break;
      }
      expandedNodes += 1;

      if (
        current.remainingPassengerIds.length < bestPartialNode.remainingPassengerIds.length ||
        (current.remainingPassengerIds.length === bestPartialNode.remainingPassengerIds.length &&
          partialNodeScore(current) < partialNodeScore(bestPartialNode))
      ) {
        bestPartialNode = current;
      }

      if (current.remainingPassengerIds.length === 0) {
        return current.orderedPassengerIds.map((id) => passengersById.get(id)).filter(Boolean);
      }

      const positionIndex = current.orderedPassengerIds.length;
      const sortedCandidates = current.remainingPassengerIds
        .slice()
        .sort((a, b) => {
          const passengerA = passengersById.get(a);
          const passengerB = passengersById.get(b);
          const scoreA = passengerA ? preliminaryPassengerPriority(passengerA, positionIndex) : -Infinity;
          const scoreB = passengerB ? preliminaryPassengerPriority(passengerB, positionIndex) : -Infinity;
          if (scoreA !== scoreB) {
            return scoreB - scoreA;
          }
          return a - b;
        })
        .slice(0, Math.min(BOUNDED_MAX_BRANCHING_CANDIDATES, current.remainingPassengerIds.length));

      const lastPassenger =
        current.lastPassengerId !== null && passengersById.has(current.lastPassengerId)
          ? passengersById.get(current.lastPassengerId)
          : null;

      for (const candidateId of sortedCandidates) {
        const nextPassenger = passengersById.get(candidateId);
        if (!nextPassenger) {
          continue;
        }
        const nextOrdered = current.orderedPassengerIds.concat(candidateId);
        const nextRemaining = current.remainingPassengerIds.filter((id) => id !== candidateId);
        const gCost = current.gCost + transitionCost(lastPassenger, nextPassenger, positionIndex);
        const hCost = estimateRemainingCost(nextRemaining, passengersById, nextOrdered.length);
        const node = {
          orderedPassengerIds: nextOrdered,
          remainingPassengerIds: nextRemaining,
          gCost,
          hCost,
          fCost: gCost + hCost,
          lastPassengerId: candidateId,
        };
        openSet.push(node);
      }

      if (openSet.length > BOUNDED_MAX_OPEN_SET_SIZE) {
        openSet.sort(nodePriorityCompare);
        openSet.length = BOUNDED_MAX_OPEN_SET_SIZE;
      }
    }

    const fallbackTail = deterministicTailOrder(
      bestPartialNode.remainingPassengerIds,
      bestPartialNode.orderedPassengerIds.length
    );
    return bestPartialNode.orderedPassengerIds
      .concat(fallbackTail)
      .map((id) => passengersById.get(id))
      .filter(Boolean);
  }

  function tickSearch(passengers) {
    if (typeof window !== "undefined" && typeof window.__aeroBoardRunTickSearch === "function") {
      return window.__aeroBoardRunTickSearch(passengers);
    }
    return boundedAStar(passengers);
  }

  function rowBinInterleave(passengers) {
    const binSpan = 6;
    const groupsByBin = new Map();
    let maxBin = 0;
    for (const passenger of passengers) {
      const row = passenger.targetSeat.row;
      const binIndex = Math.floor((row - 1) / binSpan);
      maxBin = Math.max(maxBin, binIndex);
      if (!groupsByBin.has(binIndex)) {
        groupsByBin.set(binIndex, []);
      }
      groupsByBin.get(binIndex).push(passenger);
    }
    for (const list of groupsByBin.values()) {
      list.sort((a, b) => {
        const rd = a.targetSeat.row - b.targetSeat.row;
        if (rd !== 0) {
          return rd;
        }
        return numericPassengerId(a) - numericPassengerId(b);
      });
    }
    const ordered = [];
    let round = 0;
    let added = true;
    while (added) {
      added = false;
      for (let b = 0; b <= maxBin; b += 1) {
        const list = groupsByBin.get(b);
        if (list && round < list.length) {
          ordered.push(list[round]);
          added = true;
        }
      }
      round += 1;
    }
    return ordered;
  }

  function random(passengers) {
    const groups = randomOrder(groupPassengersForBoarding(passengers));
    return flattenGroupedPassengers(groups);
  }

  window.groupPassengersForBoarding = groupPassengersForBoarding;
  window.BoardingAlgorithms = {
    random: { key: "random", label: "Random", type: "normal", run: random },
    backToFront: { key: "backToFront", label: "Back-to-Front", type: "normal", run: backToFront },
    windowMiddleAisle: {
      key: "windowMiddleAisle",
      label: "Window-Middle-Aisle (zoned)",
      type: "normal",
      run: windowMiddleAisle,
    },
    steffenDeterministic: {
      key: "steffenDeterministic",
      label: "Steffen (deterministic)",
      type: "normal",
      run: steffenDeterministic,
    },
    prototypeCluster: { key: "prototypeCluster", label: "Prototype Cluster", type: "normal", run: prototypeCluster },
    rowBinInterleave: {
      key: "rowBinInterleave",
      label: "Row-bin interleave",
      type: "normal",
      run: rowBinInterleave,
    },
    heuristicCluster: { key: "heuristicCluster", label: "Heuristic Cluster", type: "optimized", run: heuristicCluster },
    exactAStar: { key: "exactAStar", label: "Exact A*", type: "optimized", run: exactAStar },
    boundedAStar: { key: "boundedAStar", label: "Bounded A*", type: "optimized", run: boundedAStar },
    tickSearch: {
      key: "tickSearch",
      label: "Tick Search (sampled)",
      type: "optimized",
      run: tickSearch,
    },
  };
})(window);
