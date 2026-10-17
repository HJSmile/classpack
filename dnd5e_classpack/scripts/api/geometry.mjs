/** Token geometry always uses committed document data, never animation state. */
export function tokenDocument(token) { return token?.document ?? token; }

export function tokenPosition(token) {
  const doc = tokenDocument(token);
  const source = doc._source ?? doc;
  return { x: source.x, y: source.y, elevation: source.elevation ?? 0,
    width: source.width ?? doc.width, height: source.height ?? doc.height,
    shape: source.shape ?? doc.shape, level: source.level ?? doc.level };
}

export function tokenCenter(token, position = tokenPosition(token)) {
  const doc = tokenDocument(token);
  return doc.getCenterPoint({ ...tokenPosition(doc), ...position });
}

export function positionAtCenter(token, center, { snap = true, dimensions = {} } = {}) {
  const doc = tokenDocument(token);
  const source = tokenPosition(doc);
  for (const key of ["width", "height", "shape"]) if (dimensions[key] !== undefined) source[key] = dimensions[key];
  const offset = tokenCenter(doc, { ...source, x: 0, y: 0 });
  const point = { x: center.x - offset.x, y: center.y - offset.y,
    elevation: center.elevation ?? source.elevation };
  return snap ? { ...doc.getSnappedPosition({ ...source, ...point }), elevation: point.elevation } : point;
}

export function occupied(token, position, ignoredIds = new Set([tokenDocument(token).id]), reservations = []) {
  const doc = tokenDocument(token);
  const size = doc.getSize({ ...tokenPosition(doc), ...position });
  const overlaps = (other, spot) => {
    if ((spot.level ?? other.level) !== (position.level ?? doc.level)
      || (spot.elevation ?? 0) !== (position.elevation ?? doc.elevation ?? 0)) return false;
    const otherSize = other.getSize({ ...tokenPosition(other), ...spot });
    return position.x < spot.x + otherSize.width && position.x + size.width > spot.x
      && position.y < spot.y + otherSize.height && position.y + size.height > spot.y;
  };
  return Array.from(doc.parent.tokens).some(other => !ignoredIds.has(other.id) && overlaps(other, tokenPosition(other)))
    || reservations.some(({ token: other, position: spot }) => overlaps(tokenDocument(other), spot));
}

export function pointDistance(scene, from, to) {
  return scene.grid.measurePath([
    { x: from.x, y: from.y, elevation: from.elevation ?? 0 },
    { x: to.x, y: to.y, elevation: to.elevation ?? from.elevation ?? 0 }
  ]).distance;
}
