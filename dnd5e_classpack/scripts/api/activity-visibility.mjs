import { MODULE_ID } from "./utils.mjs";

let activityVisibilityInstalled = false;
const hiddenByClasspack = activity => activity?.flags?.[MODULE_ID]?.hidden === true;

/** Persistently hide an activity from use and the item editor. Pass false to show it again. */
export async function hideActivity(activity, hidden = true) {
  const uuid = typeof activity === "string" ? activity : activity.uuid;
  if (game.user.isGM) return hideActivityOnGM(uuid, hidden);
  const socket = globalThis.dnd5eClasspack.socket;
  if (!socket) throw new Error("ClassPack activity visibility requires socketlib and an online GM.");
  return socket.executeAsGM("hideActivity", uuid, hidden);
}

export async function hideActivityOnGM(uuid, hidden = true) {
  if (!game.user.isGM) throw new Error("ClassPack activity visibility must execute on a GM client.");
  const activity = await fromUuid(uuid);
  await activity.update({ [`flags.${MODULE_ID}.hidden`]: hidden });
  return activity.uuid;
}

export function installActivityVisibility() {
  if (activityVisibilityInstalled || !globalThis.libWrapper) return false;
  const classes = new Set();
  for (const [type, { documentClass }] of Object.entries(CONFIG.DND5E.activityTypes)) {
    if (!documentClass || classes.has(documentClass)) continue;
    classes.add(documentClass);
    const target = `CONFIG.DND5E.activityTypes.${type}.documentClass.prototype`;
    libWrapper.register(MODULE_ID, `${target}.isHidden`, function (wrapped) {
      const hidden = wrapped();
      return hidden || hiddenByClasspack(this);
    }, "WRAPPER");
    libWrapper.register(MODULE_ID, `${target}.canConfigure`, function (wrapped) {
      const configurable = wrapped();
      return configurable && !hiddenByClasspack(this);
    }, "WRAPPER");
  }
  libWrapper.register(MODULE_ID, "dnd5e.applications.actor.CharacterActorSheet.prototype._prepareFavorites",
    async function (wrapped, ...args) {
      const favorites = await wrapped(...args);
      return favorites.filter(entry => entry.type !== "activity" || !hiddenByClasspack(
        this.actor.items.get(entry.itemId)?.system.activities.get(entry.activityId)
      ));
    }, "WRAPPER");
  activityVisibilityInstalled = true;
  return true;
}
