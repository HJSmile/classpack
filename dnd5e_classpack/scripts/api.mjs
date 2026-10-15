/**
 * ClassPack shared API entry point.
 *
 * Exposes:
 * - socketlib-backed remote functions (updateTargets / teleport)
 * - ClasspackDialogApp: an ApplicationV2-based dialog window
 * - ClasspackTeleport: point-and-click token teleporting
 * - ClasspackCrosshairs: the Region placement facade used by teleport
 * - dialogUtils: dialog helpers (buttonDialog, selectTargetDialog, ...)
 *
 * Global access:
 *   globalThis.dnd5eClasspack / globalThis.classpack
 *   socket handle: dnd5eClasspack.socket
 *
 * The implementation is split across `scripts/api/` for maintainability. The
 * GitHub release workflow bundles this entry and its imports back into a single
 * `scripts/api.mjs` file.
 */

import { canUpdateToken, firstOwner, log, MODULE_ID, SOCKET_NAME, registerHandlebarsHelpers, resolveOriginPoint, resolveToken, resolveUserId, toSocketSafeOptions } from "./api/utils.mjs";
import { ClasspackDialogApp } from "./api/dialog-app.mjs";
import { ClasspackCrosshairs } from "./api/crosshairs.mjs";
import { ClasspackTeleport } from "./api/teleport.mjs";
import { createDialogUtils } from "./api/dialog-utils.mjs";
import { calculatePushUpdates } from "./api/push.mjs";
import { socketFunctions } from "./api/socket-functions.mjs";
import { createActorItems, addFavorite } from "./api/actor-items.mjs";
import { hideActivity, installActivityVisibility } from "./api/activity-visibility.mjs";
import { moveTokens, registerMovementActions } from "./api/movement.mjs";
import { tokenDocument } from "./api/geometry.mjs";
import { checkCompatibility, isCompatibleVersion } from "./compatibility.mjs";
import { registerMigrationSettings, notifyPendingMigrations, worldMigrations } from "./migrations/index.mjs";

import { createAutomationRegistry } from "./api/automations.mjs";
import { createResourceApi } from "./api/resources.mjs";
import { createRollApi } from "./api/rolls.mjs";
import { createRollDisplayApi } from "./api/roll-display.mjs";
import { createRollInterventionApi } from "./api/roll-interventions.mjs";
import { registerLucky2014 } from "./api/lucky2014.mjs";

const api = {
  createActorItems,
  addFavorite,
  hideActivity,
  socket: null,
  compatibility: null,
  migrations: worldMigrations,
  DialogApp: ClasspackDialogApp,
  Crosshairs: ClasspackCrosshairs,
  Teleport: ClasspackTeleport,

  /**
   * Open an ApplicationV2 dialog:
   * dialog(title, content, inputs, buttons, options?)
   *
   * The optional fifth argument may include `userId` (or `user`). When that
   * user is not the current client, the dialog is opened on their client via
   * socketlib and the result is returned here.
   */
  dialog: async (...args) => {
    const options = args[4] ?? {};
    const targetUserId = resolveUserId(options.userId ?? options.user);

    if (targetUserId && targetUserId !== game.user.id) {
      if (!api.socket) {
        log("warn", "socketlib is not ready; opening the dialog on the local client instead.");
        return ClasspackDialogApp.dialog(...args);
      }
      const remoteArgs = [...args];
      remoteArgs[4] = toSocketSafeOptions(options, targetUserId);
      return await api.socket.executeAsUser("dialog", targetUserId, ...remoteArgs);
    }

    return await ClasspackDialogApp.dialog(...args);
  },

  /**
   * Set targets on the local client, or on another user's client via socketlib.
   */
  updateTargets: async function (tokens, user = game.user) {
    const list = Array.isArray(tokens) || tokens instanceof Set ? tokens : [tokens];
    const ids = Array.from(list).map(token => token?.id ?? token);

    let targetUser = typeof user === "string" ? game.users.get(user) : user;
    if (!targetUser) targetUser = game.user;

    if (targetUser === game.user) {
      canvas.tokens?.setTargets(ids);
    } else {
      if (!api.socket) {
        log("warn", "socketlib is not ready; updateTargets only affects the local client.");
        return;
      }
      await api.socket.executeAsUser("updateTargets", targetUser.id, ids);
    }
  },

  /**
   * Teleport one or more tokens.
   *
   * Two modes:
   * - Point mode (target omitted/null): the crosshair is anchored on the first
   *   token (or `options.centerpoint`) and the destination can be picked
   *   anywhere within `options.range`.
   * - Token mode (target provided): the crosshair is anchored on the target
   *   token and the moved tokens are placed relative to that point.
   *
   * Tokens and target can be Token placeables, TokenDocuments, or UUID strings.
   *
   * Options:
   * - `centerpoint`: a Token, TokenDocument, UUID string, or plain `{x, y}`
   *   point to use as the range anchor / reference point. Defaults to the
   *   controlling token centre (the target token in token mode, the first
   *   moved token in point mode).
   * - `userId` / `user`: run the teleport (including its crosshair UI) on that
   *   user's client via socketlib.
   * - If no user is specified and the local user lacks update permission for
   *   the moved tokens, the crosshair UI still runs on the
   *   local client, and only the final token position updates are sent to a GM
   *   client via socketlib.
   */
  teleport: async function (tokens, target = null, options = {}) {
    const list = Array.isArray(tokens) || tokens instanceof Set ? Array.from(tokens) : [tokens];
    const resolved = (await Promise.all(list.map(resolveToken))).filter(Boolean);
    if (!resolved.length) return;
    const sceneId = tokenDocument(resolved[0]).parent.id;
    if (sceneId !== canvas.scene?.id) throw new Error("ClassPack placement requires the originating scene to be viewed.");
    const reference = target == null ? null : await resolveToken(target);
    if (target != null && !reference) return;
    const requested = resolveUserId(options.userId ?? options.user);
    if (requested && requested !== game.user.id && api.socket) {
      const remote = toSocketSafeOptions({ ...options,
        centerpoint: options.centerpoint ? await resolveOriginPoint(options.centerpoint) : undefined }, requested);
      const uuids = resolved.map(token => tokenDocument(token).uuid);
      return reference ? api.socket.executeAsUser("teleport", requested, uuids, tokenDocument(reference).uuid, remote)
        : api.socket.executeAsUser("teleportPoint", requested, uuids, remote);
    }
    const local = resolved.every(canUpdateToken);
    if (!local && !api.socket) {
      log("warn", "No permission to move these tokens; socketlib is unavailable.");
      return { x: 0, y: 0, direction: 0, elevation: 0, valid: false, cancelled: true };
    }
    const settings = local ? options : { ...options, commit: updates => api.socket.executeAsGM("teleportUpdate", sceneId, updates,
      { animate: options.animate === true, animation: options.movementAnimation }) };
    return reference ? (resolved.length > 1 ? ClasspackTeleport.group(resolved, reference, settings)
      : ClasspackTeleport.target(resolved[0], reference, settings)) : ClasspackTeleport.point(resolved, settings);
  },

  /** Push/pull in scene units, using a zero-cost forced movement action. */
  push: async function (targets, origin, distance, options = {}) {
    const list = Array.isArray(targets) || targets instanceof Set ? Array.from(targets) : [targets];
    const resolved = (await Promise.all(list.map(resolveToken))).filter(Boolean);
    if (!resolved.length) return {};
    const sceneId = tokenDocument(resolved[0]).parent.id;
    if (resolved.some(token => tokenDocument(token).parent.id !== sceneId)) throw new Error("ClassPack push requires one scene.");
    const point = await resolveOriginPoint(origin);
    if (!point) return {};
    const updates = calculatePushUpdates(resolved, point, Number(distance), options);
    const movementOptions = { animate: options.animate !== false, animation: options.animation };
    if (resolved.every(canUpdateToken)) return moveTokens(sceneId, updates, movementOptions);
    if (api.socket) return api.socket.executeAsGM("pushUpdate", sceneId, updates, movementOptions);
    log("warn", "No permission to move these tokens; socketlib is unavailable.");
    return {};
  },

  /**
   * Convenience wrapper for `push` with a negative distance.
   */
  pull: async function (targets, origin, distance, options = {}) {
    return await api.push(targets, origin, -Math.abs(distance), options);
  }
};

api.dialogUtils = createDialogUtils((...args) => api.dialog(...args));
api.firstOwner = firstOwner;
api.automations = createAutomationRegistry();
api.resources = createResourceApi(api);
api.rolls = createRollApi(api);
api.rollDisplay = createRollDisplayApi();
api.rollInterventions = createRollInterventionApi(api);
api.lucky2014 = registerLucky2014(api);

/* -------------------------------------------------------------------------- *
 *  Registration
 * -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  registerMigrationSettings();
  api.lucky2014.registerSettings();
  api.rollInterventions.installEffectFilter();
  registerHandlebarsHelpers();
  registerMovementActions();
  const module = game.modules?.get?.(MODULE_ID);
  if (module) module.api = api;
});

Hooks.once("socketlib.ready", () => {
  const socketlib = globalThis.socketlib;
  const dependency = Array.from(game.modules.get(MODULE_ID).relationships.requires).find(entry => entry.id === "socketlib");
  const installed = game.modules.get("socketlib");
  if (!socketlib || !installed?.active || !isCompatibleVersion(installed.version, dependency?.compatibility)) {
    log("warn", "socketlib is not available; remote functions will be disabled.");
    return;
  }

  api.socket = socketlib.registerModule(SOCKET_NAME);
  if (!api.socket) {
    log("warn", "socketlib rejected the socket registration (is `socket: true` set in module.json?).");
    return;
  }

  for (const [name, fn] of Object.entries(socketFunctions)) {
    api.socket.register(name, fn);
  }
  log("info", "socket functions registered:", Object.keys(socketFunctions).join(", "));
});

Hooks.once("ready", () => {
  api.compatibility = checkCompatibility();
  installActivityVisibility();
  api.rollDisplay.install();
  try {
    if (game.modules.get("midi-qol")?.active && api.socket && globalThis.libWrapper) {
      api.lucky2014.prepareLegacyBridge();
      api.rollInterventions.install();
      api.rolls.install();
      api.rollInterventions.refreshActors();
    }
  } catch (error) { log("error", "Roll automation initialization failed:", error); }
  notifyPendingMigrations();
  Hooks.callAll("dnd5eClasspackReady", api);
});

globalThis.dnd5eClasspack = api;
globalThis.classpack = api;
