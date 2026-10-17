import { tokenCenter, tokenDocument } from "./geometry.mjs";
/**
 * ClassPack API helpers.
 */

export const MODULE_ID = "dnd5e_classpack";
export const SOCKET_NAME = "dnd5e_classpack";

export function log(level, ...args) {
  console[level]?.(`[${MODULE_ID}]`, ...args);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function mergeMultiple(...sources) {
  return sources.reduce((acc, source) => {
    return foundry.utils.mergeObject(acc, source ?? {});
  }, {});
}

export function localize(key, fallback = key) {
  const value = game.i18n.localize(key);
  return value === key ? fallback : value;
}

/**
 * Register the small set of Handlebars helpers the dialog template needs.
 * Foundry registers these in most versions, but ensure they exist without
 * clobbering an existing helper.
 */
export function registerHandlebarsHelpers() {
  const helpers = {
    gte: (a, b) => a >= b,
    gt: (a, b) => a > b,
    eq: (a, b) => a === b
  };
  for (const [name, fn] of Object.entries(helpers)) {
    if (!Handlebars.helpers[name]) Handlebars.registerHelper(name, fn);
  }
}

/**
 * Resolve a token-like value to a Token placeable or its document. Accepts TokenDocuments,
 * Token placeables, canvas token ids, or UUID strings.
 */
export async function resolveToken(tokenish) {
  // Token placeable.
  if (tokenish?.document?.documentName === "Token") return tokenish;

  // Unrendered documents retain their own scene; do not match a different
  // scene's canvas token by a coincidentally identical embedded id.
  if (tokenish?.documentName === "Token") {
    return tokenish.object ?? tokenish;
  }

  if (typeof tokenish === "string") {
    const onCanvas = canvas.tokens?.get(tokenish);
    if (onCanvas) return onCanvas;

    const doc = await fromUuid(tokenish);
    if (doc?.documentName === "Token") {
      return doc.object ?? doc;
    }
    return doc?.object ?? undefined;
  }

  return tokenish;
}

/**
 * Normalize a user-ish value to a user id. Accepts a User document, a user id
 * string, or a user id embedded in an object.
 */
export function resolveUserId(value, fallback = game.user) {
  if (value === undefined || value === null) {
    return typeof fallback === "string" ? fallback : fallback?.id;
  }
  if (typeof value === "string") return value;
  return value?.id ?? value;
}

/**
 * Whether the local user can update the given token (or token document).
 */
export function canUpdateToken(tokenish) {
  const doc = tokenish?.document ?? tokenish;
  if (!doc) return false;
  if (game.user?.isGM) return true;

  try {
    if (typeof doc.canUserModify === "function") return doc.canUserModify(game.user, "update");
    if (typeof doc.testUserPermission === "function") return doc.testUserPermission(game.user, "OWNER");
  } catch (err) {
    log("warn", "Could not determine token update permission:", err);
  }

  return doc.owner?.[game.user?.id] === "OWNER";
}

/**
 * Return a copy of `options` that is safe to send through a socket. User
 * document references and functions are not serialisable, so they are removed.
 */
export function toSocketSafeOptions(options = {}, targetUserId) {
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(options));
  } catch (err) {
    copy = { ...options };
  }
  delete copy.user;
  if (targetUserId !== undefined) copy.userId = targetUserId;
  return copy;
}

/** Resolve a committed Token center, a single Region shape origin, UUID or point. */
export async function resolveOriginPoint(origin) {
  if (typeof origin === "string") origin = await fromUuid(origin);
  const doc = tokenDocument(origin);
  if (doc?.documentName === "Token") return tokenCenter(doc);
  if (doc?.documentName === "Region") {
    const shapes = doc._source?.shapes ?? doc.shapes;
    if (shapes?.length === 1 && Number.isFinite(shapes[0].x) && Number.isFinite(shapes[0].y)) {
      return { x: shapes[0].x, y: shapes[0].y };
    }
    log("warn", "Multi-shape Regions need an explicit reference point.");
    return undefined;
  }
  if (Number.isFinite(origin?.x) && Number.isFinite(origin?.y)) {
    return { x: origin.x, y: origin.y, ...(Number.isFinite(origin.elevation) ? { elevation: origin.elevation } : {}) };
  }
  log("warn", "resolveOriginPoint: could not resolve the reference origin.");
}

/**
 * Normalise a token, item, effect or actor reference down to an Actor document.
 * Non document values are returned unchanged.
 */
function asActor(doc) {
  if (!doc) return undefined;
  const document = doc.document ?? doc;

  switch (document.documentName) {
    case "Token":
      return document.actor ?? document.object?.actor;
    case "Item":
    case "ActiveEffect":
      return document.actor ?? document.parent;
    default:
      return document;
  }
}

/**
 * Pick the client that should act on behalf of a document: the first active,
 * non-GM user with OWNER permission, preferring the user whose character owns
 * the actor. Falls back to an active GM when nobody else can act.
 *
 * @param {*} doc             Actor, Token, Item or ActiveEffect (document or placeable).
 * @param {boolean} [asId]    When true, return the user id instead of a User.
 * @returns {User|string|undefined}
 */
export function firstOwner(doc, asId = false) {
  const actor = asActor(doc);
  if (!actor) return undefined;

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ownership = foundry.utils.getProperty(actor, "ownership") ?? {};

  const owners = [];
  for (const [userId, granted] of Object.entries(ownership)) {
    if (granted !== ownerLevel) continue;
    const user = game.users?.get(userId);
    if (!user || user.isGM || !user.active) continue;
    owners.push(user);
  }

  const owner =
    owners.find(user => user.character?.uuid === actor.uuid)
    ?? owners[0]
    ?? game.users?.activeGM
    ?? game.users?.find(user => user.active && user.isGM);

  if (!owner) return undefined;
  return asId ? owner.id : owner;
}
