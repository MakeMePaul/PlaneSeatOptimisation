import { describe, expect, test, vi } from "vitest";
import { assertPermutation, getTestExports, makeBlueprint, runUntilFinished } from "./helpers.js";

function getWindow() {
  return globalThis.window ?? globalThis;
}

function exportsFromWindow() {
  return getTestExports(getWindow());
}

function boardingAlgorithms() {
  const w = getWindow();
  const alg = w.BoardingAlgorithms;
  if (!alg) {
    throw new Error("BoardingAlgorithms missing on window");
  }
  return alg;
}

describe("AeroBoard simulation", () => {
  test("1: one passenger boards and becomes seated", () => {
    const { Simulation, createSeededRng, ROWS, SEATS } = exportsFromWindow();
    const rng = createSeededRng(42);
    const sim = new Simulation({
      rows: ROWS,
      seats: SEATS,
      totalPassengers: 1,
      algorithm: "random",
      algorithmRegistry: boardingAlgorithms(),
      basePassengerSet: [makeBlueprint({ id: 1, row: 10, seat: "C", stowTime: 1 })],
      blueprintSeed: 999,
      rng,
    });
    runUntilFinished(sim);
    const seated = sim.allPassengers.filter((p) => p.state === "seated");
    expect(seated).toHaveLength(1);
    expect(seated[0].targetSeat.row).toBe(10);
    expect(seated[0].targetSeat.seat).toBe("C");
  });

  test("2: aisle collision prevents advancing into occupied cell (walking blocked)", () => {
    const { Simulation, createSeededRng, ROWS, SEATS } = exportsFromWindow();
    const p1 = makeBlueprint({ id: 1, row: 10, seat: "C", stowTime: 25 });
    const p2 = makeBlueprint({ id: 2, row: 11, seat: "C", stowTime: 2 });
    const registry = {
      ...boardingAlgorithms(),
      __testOrder: {
        key: "__testOrder",
        label: "test",
        type: "normal",
        run: (passengers) => passengers.slice().sort((a, b) => a.id - b.id),
      },
    };
    const sim = new Simulation({
      rows: ROWS,
      seats: SEATS,
      totalPassengers: 2,
      algorithm: "__testOrder",
      algorithmRegistry: registry,
      basePassengerSet: [p1, p2],
      blueprintSeed: 1,
      rng: createSeededRng(1),
    });

    let maxWalkingBlocked = 0;
    for (let t = 0; t < 50000 && !sim.isFinished(); t += 1) {
      sim.tick();
      maxWalkingBlocked = Math.max(maxWalkingBlocked, sim.runMetrics.walkingBlockedTicks);
    }
    expect(sim.isFinished()).toBe(true);
    expect(maxWalkingBlocked).toBeGreaterThan(0);
  });

  test("3: stowing passenger occupies an aisle slot (blocks spawn path)", () => {
    const { Simulation, createSeededRng, ROWS, SEATS } = exportsFromWindow();
    const registry = {
      ...boardingAlgorithms(),
      __testOrder: {
        key: "__testOrder",
        label: "test",
        type: "normal",
        run: (passengers) => passengers.slice().sort((a, b) => a.id - b.id),
      },
    };
    const sim = new Simulation({
      rows: ROWS,
      seats: SEATS,
      totalPassengers: 2,
      algorithm: "__testOrder",
      algorithmRegistry: registry,
      basePassengerSet: [
        makeBlueprint({ id: 1, row: 1, seat: "C", stowTime: 45 }),
        makeBlueprint({ id: 2, row: 10, seat: "C", stowTime: 2 }),
      ],
      blueprintSeed: 7,
      rng: createSeededRng(7),
    });

    let sawStowingInAisle = false;
    let queueHeldWhileStowAtDoor = false;
    for (let t = 0; t < 12000 && !sim.isFinished(); t += 1) {
      for (let i = 0; i < sim.plane.aisle.length; i += 1) {
        const p = sim.plane.aisle[i];
        if (p && p.state === "stowing") {
          sawStowingInAisle = true;
          expect(sim.plane.aisle[i]).toBe(p);
          if (i === 0 && sim.waitingQueue.length > 0) {
            queueHeldWhileStowAtDoor = true;
          }
        }
      }
      sim.tick();
    }
    expect(sawStowingInAisle).toBe(true);
    expect(queueHeldWhileStowAtDoor).toBe(true);
  });

  test("4: seating state keeps passenger in aisle until seated", () => {
    const { Simulation, createSeededRng, ROWS, SEATS } = exportsFromWindow();
    const sim = new Simulation({
      rows: ROWS,
      seats: SEATS,
      totalPassengers: 1,
      algorithm: "random",
      algorithmRegistry: boardingAlgorithms(),
      basePassengerSet: [makeBlueprint({ id: 1, row: 1, seat: "A", stowTime: 1 })],
      blueprintSeed: 11,
      rng: createSeededRng(11),
    });
    sim.plane.seats[1]["B"] = { id: "dummy-b" };
    sim.plane.seats[1]["C"] = { id: "dummy-c" };

    let sawSeatingInAisle = false;
    for (let t = 0; t < 50000 && !sim.isFinished(); t += 1) {
      for (let i = 0; i < sim.plane.aisle.length; i += 1) {
        const p = sim.plane.aisle[i];
        if (p && p.state === "seating") {
          sawSeatingInAisle = true;
          expect(sim.plane.aisle[i]).toBe(p);
        }
      }
      sim.tick();
    }
    expect(sawSeatingInAisle).toBe(true);
  });

  test("5 and 6: seat occupancy when finished; queue and aisle empty", () => {
    const { Simulation, createSeededRng, ROWS, SEATS } = exportsFromWindow();
    const sim = new Simulation({
      rows: ROWS,
      seats: SEATS,
      totalPassengers: 3,
      algorithm: "random",
      algorithmRegistry: boardingAlgorithms(),
      basePassengerSet: [
        makeBlueprint({ id: 1, row: 2, seat: "D", stowTime: 1 }),
        makeBlueprint({ id: 2, row: 3, seat: "C", stowTime: 1 }),
        makeBlueprint({ id: 3, row: 4, seat: "F", stowTime: 1 }),
      ],
      blueprintSeed: 3,
      rng: createSeededRng(3),
    });
    runUntilFinished(sim);
    const c = sim.counts();
    expect(c.waiting).toBe(0);
    expect(c.aisle).toBe(0);
    expect(sim.plane.getOccupiedSeatsCount()).toBe(3);
    expect(sim.isFinished()).toBe(true);
  });
});

describe("AeroBoard algorithms", () => {
  test("7 and 8: each algorithm returns a permutation of the same passengers", () => {
    const { createSeededRng } = exportsFromWindow();
    const registry = boardingAlgorithms();
    const rng = createSeededRng(202);
    const blueprintSeed = 404;
    const passengers = [
      makeBlueprint({ id: 10, row: 12, seat: "A", stowTime: 4 }),
      makeBlueprint({ id: 11, row: 8, seat: "F", stowTime: 3 }),
      makeBlueprint({ id: 12, row: 22, seat: "C", stowTime: 5 }),
    ];

    for (const key of Object.keys(registry)) {
      const entry = registry[key];
      if (!entry || typeof entry.run !== "function") {
        continue;
      }
      const opts = { rng, blueprintSeed };
      const out = entry.run(passengers.slice(), opts);
      assertPermutation(passengers, out);
    }
  });

  test("9: exactAStar falls back safely for >9 passengers; boundedAStar handles 120", () => {
    const registry = boardingAlgorithms();
    const { createSeededRng, ROWS, SEATS } = exportsFromWindow();
    const rng = createSeededRng(55);
    const letters = SEATS;
    const many = [];
    let id = 1;
    outer: for (let r = 1; r <= ROWS; r += 1) {
      for (const s of letters) {
        many.push(
          makeBlueprint({
            id,
            row: r,
            seat: s,
            stowTime: 4,
          })
        );
        id += 1;
        if (many.length >= 120) {
          break outer;
        }
      }
    }
    const ten = many.slice(0, 10);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outExact = registry.exactAStar.run(ten, { rng, blueprintSeed: 1 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    assertPermutation(ten, outExact);

    const outBounded = registry.boundedAStar.run(many, { rng, blueprintSeed: 2 });
    assertPermutation(many, outBounded);
  });

  test("10: prototypeCluster orders by row bands, not by misleading clusterId", () => {
    const registry = boardingAlgorithms();
    const { createSeededRng } = exportsFromWindow();
    const pFront = {
      ...makeBlueprint({ id: 1, row: 3, seat: "A", stowTime: 1 }),
      clusterId: "cluster_4",
    };
    const pRear = {
      ...makeBlueprint({ id: 2, row: 27, seat: "F", stowTime: 1 }),
      clusterId: "cluster_1",
    };
    const out = registry.prototypeCluster.run([pFront, pRear], { rng: createSeededRng(1), blueprintSeed: 1 });
    expect(out[0].id).toBe(2);
    expect(out[1].id).toBe(1);
  });
});
