/**
 * Socket-backed functions.
 */

import { moveTokens } from "./movement.mjs";
import { ClasspackDialogApp } from "./dialog-app.mjs";
import { createActorItemsOnGM, addFavoriteOnGM, removeFavoriteOnGM } from "./actor-items.mjs";
import { hideActivityOnGM } from "./activity-visibility.mjs";

/* -------------------------------------------------------------------------- *
 *  Local API + socket functions
 * -------------------------------------------------------------------------- */

const socketFunctions = {
  createActorItems: createActorItemsOnGM,
  addFavorite: addFavoriteOnGM,
  removeFavorite: removeFavoriteOnGM,
  hideActivity: hideActivityOnGM,
  resourceConsume: request => globalThis.dnd5eClasspack.resources.consumeOnGM(request),
  rollInterventionResolve: request => globalThis.dnd5eClasspack.rollInterventions.resolve(request),
  /**
   * Open a dialog on the executing client. Args are forwarded to
   * ClasspackDialogApp.dialog and the dialog result is returned to the caller.
   */
  dialog: async (...args) => ClasspackDialogApp.dialog(...args),

  /**
   * Set targets for the local canvas. `tokens` is an array of token ids (or
   * objects exposing `.id`).
   */
  updateTargets: async function (tokens) {
    const list = Array.isArray(tokens) || tokens instanceof Set ? tokens : [tokens];
    const ids = Array.from(list).map(token => token?.id ?? token);
    canvas.tokens?.setTargets(ids);
  },

  /** Movement commits always name the originating scene. */
  teleportUpdate: (sceneId, updates, options = {}) => moveTokens(sceneId, updates, { ...options, teleport: true }),
  pushUpdate: (sceneId, updates, options = {}) => moveTokens(sceneId, updates, { ...options, teleport: false }),

  // Re-enter the public API on the selected client so permission/GM forwarding
  // and scene validation are identical to local calls.
  teleportPoint: (uuids, options = {}) => globalThis.dnd5eClasspack.teleport(uuids, null, { ...options, userId: game.user.id }),
  teleport: (uuids, target, options = {}) => globalThis.dnd5eClasspack.teleport(uuids, target, { ...options, userId: game.user.id })
};
export { socketFunctions };
