/** @param {unknown} value */
export function getTestExports(value) {
  const g = /** @type {Record<string, unknown>} */ (typeof value !== "undefined" ? value : globalThis);
  const exp = g.__AeroBoardTestExports;
  if (!exp || typeof exp !== "object") {
    throw new Error("Missing __AeroBoardTestExports (run tests/setup.js first)");
  }
  return exp;
}

/**
 * @param {Array<{ id: number }>} input
 * @param {Array<{ id: number }>} output
 */
export function assertPermutation(input, output) {
  if (output.length !== input.length) {
    throw new Error(`Length mismatch: input ${input.length}, output ${output.length}`);
  }
  const sortedIn = input.map((p) => p.id).slice().sort((a, b) => a - b);
  const sortedOut = output.map((p) => p.id).slice().sort((a, b) => a - b);
  if (sortedIn.join(",") !== sortedOut.join(",")) {
    throw new Error(`Multiset mismatch: in [${sortedIn}], out [${sortedOut}]`);
  }
  const seen = new Set();
  for (const p of output) {
    if (seen.has(p.id)) {
      throw new Error(`Duplicate id in output: ${p.id}`);
    }
    seen.add(p.id);
  }
}

/**
 * @param {{ tick: () => void, isFinished: () => boolean }} sim
 * @param {number} maxTicks
 */
export function runUntilFinished(sim, maxTicks = 500000) {
  let n = 0;
  while (!sim.isFinished()) {
    sim.tick();
    n += 1;
    if (n > maxTicks) {
      throw new Error(`Simulation did not finish within ${maxTicks} ticks`);
    }
  }
}

/**
 * @param {object} fields
 */
export function makeBlueprint(fields) {
  return {
    id: fields.id,
    targetSeat: { row: fields.row, seat: fields.seat },
    stowTime: fields.stowTime ?? 2,
    profileKey: fields.profileKey ?? "standard",
    profileLabel: fields.profileLabel ?? "Standard",
    moveCooldown: fields.moveCooldown ?? 0,
    groupId: fields.groupId ?? null,
    clusterId: fields.clusterId,
  };
}
