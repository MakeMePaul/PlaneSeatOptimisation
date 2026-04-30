(function attachAlgorithms(globalScope) {
  "use strict";

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

  function windowMiddleAisle(passengers) {
    const groups = randomOrder(groupPassengersForBoarding(passengers));
    groups.sort((a, b) => {
      const sampleA = a.passengers[0];
      const sampleB = b.passengers[0];
      const typeA = seatType(sampleA.targetSeat.seat);
      const typeB = seatType(sampleB.targetSeat.seat);
      if (typeA !== typeB) {
        return typeA - typeB;
      }
      return b.maxTargetRow - a.maxTargetRow;
    });
    return flattenGroupedPassengers(groups);
  }

  function prototypeCluster(passengers) {
    const clusterPriority = {
      cluster_1: 1,
      cluster_2: 2,
      cluster_3: 3,
      cluster_4: 4,
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

  function random(passengers) {
    const groups = randomOrder(groupPassengersForBoarding(passengers));
    return flattenGroupedPassengers(groups);
  }

  globalScope.BoardingAlgorithms = {
    random,
    backToFront,
    windowMiddleAisle,
    prototypeCluster,
    groupPassengersForBoarding,
  };
})(window);
