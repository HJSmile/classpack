import { occupied, positionAtCenter, tokenCenter, tokenDocument, tokenPosition } from "./geometry.mjs";

/** Signed distance in scene units. Back off after snapping and never pull past the origin. */
export function calculatePushUpdate(target, originPoint, distance,
  { checkCollision = true, avoidOccupied = false, reservations = [] } = {}) {
  const doc = tokenDocument(target), scene = doc?.parent;
  if (!scene || !originPoint || !Number.isFinite(distance) || !distance) return;
  const source = tokenPosition(target), center = tokenCenter(target, source);
  const dx = center.x - originPoint.x, dy = center.y - originPoint.y, length = Math.hypot(dx, dy);
  if (!length) return;
  const pixelsPerUnit = scene.grid.size / scene.grid.distance;
  let travel = Math.abs(distance) * pixelsPerUnit;
  if (distance < 0) travel = Math.min(travel, Math.max(0, length - scene.grid.size * 0.01));
  const sign = Math.sign(distance), step = scene.grid.size;
  const seen = new Set();
  for (; travel > 1e-6; travel = Math.max(0, travel - step)) {
    const raw = { x: center.x + dx / length * sign * travel,
      y: center.y + dy / length * sign * travel, elevation: source.elevation };
    const landing = positionAtCenter(target, raw);
    const key = `${landing.x},${landing.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snapped = tokenCenter(target, landing);
    const along = ((snapped.x - center.x) * dx + (snapped.y - center.y) * dy) / length;
    if (sign * along <= 1e-6 || (distance < 0 && -along >= length - 1e-6)) continue;
    // Snapping may round forward. Do not exceed the requested displacement.
    if (Math.hypot(snapped.x - center.x, snapped.y - center.y) > Math.abs(distance) * pixelsPerUnit + 1e-6) continue;
    const object = doc.object ?? target;
    if (checkCollision && object.checkCollision?.(snapped, { origin: center, type: "move", mode: "any" })) continue;
    if (avoidOccupied && occupied(target, landing, new Set([doc.id]), reservations)) continue;
    return { _id: doc.id, ...landing };
  }
}

export function calculatePushUpdates(targets, originPoint, distance, options = {}) {
  const updates = [], reservations = [];
  for (const target of targets) {
    const update = calculatePushUpdate(target, originPoint, distance, { ...options, reservations });
    if (update) { updates.push(update); reservations.push({ token: target, position: update }); }
  }
  return updates;
}
