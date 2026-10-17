const actorItemQueues = new Map();

/** Create actor-owned items and optionally favorite them on the same GM client. Returns UUIDs. */
export async function createActorItems(actor, items, options = {}) {
  const actorUuid = typeof actor === "string" ? actor : actor.uuid;
  const data = Array.isArray(items) ? items : [items];
  if (game.user.isGM) return createActorItemsOnGM(actorUuid, data, options);
  const socket = globalThis.dnd5eClasspack.socket;
  if (!socket) throw new Error("ClassPack item creation requires socketlib and an online GM.");
  return socket.executeAsGM("createActorItems", actorUuid, data, options);
}

export async function createActorItemsOnGM(actorUuid, data, { favorite = false, ...options } = {}) {
  if (!game.user.isGM) throw new Error("ClassPack item creation must execute on a GM client.");
  const actor = await fromUuid(actorUuid);
  if (actor?.documentName !== "Actor") throw new Error("ClassPack item creation requires an Actor UUID.");
  return queueActorItems(actor, async () => {
    const items = await actor.createEmbeddedDocuments("Item", data, options);
    if (favorite) {
      for (const item of items) await actor.system.addFavorite({
        type: "item", id: foundry.utils.buildRelativeUuid(item, actor)
      });
    }
    return items.map(item => item.uuid);
  });
}

/** Favorite an actor-owned item or activity. Accepts a document or UUID; returns its UUID. */
export async function addFavorite(document) {
  const uuid = typeof document === "string" ? document : document.uuid;
  if (game.user.isGM) return addFavoriteOnGM(uuid);
  const socket = globalThis.dnd5eClasspack.socket;
  if (!socket) throw new Error("ClassPack favorites require socketlib and an online GM.");
  return socket.executeAsGM("addFavorite", uuid);
}

export async function addFavoriteOnGM(uuid) {
  if (!game.user.isGM) throw new Error("ClassPack favorites must execute on a GM client.");
  const document = await fromUuid(uuid);
  const item = document?.item ?? document;
  const actor = item?.actor;
  if (!actor?.system?.addFavorite) throw new Error("ClassPack favorites require an actor-owned item or activity.");
  return queueActorItems(actor, async () => {
    await actor.system.addFavorite({
      type: document.item ? "activity" : "item",
      id: foundry.utils.buildRelativeUuid(item, actor) + (document.item ? `.Activity.${document.id}` : "")
    });
    return document.uuid;
  });
}

/** Remove an actor-owned item or activity from favorites. Accepts a document or UUID; returns its UUID. */
export async function removeFavorite(document) {
  const uuid = typeof document === "string" ? document : document.uuid;
  if (game.user.isGM) return removeFavoriteOnGM(uuid);
  const socket = globalThis.dnd5eClasspack.socket;
  if (!socket) throw new Error("ClassPack favorites require socketlib and an online GM.");
  return socket.executeAsGM("removeFavorite", uuid);
}

export async function removeFavoriteOnGM(uuid) {
  if (!game.user.isGM) throw new Error("ClassPack favorites must execute on a GM client.");
  const document = await fromUuid(uuid);
  const item = document?.item ?? document;
  const actor = item?.actor;
  if (!actor?.system?.removeFavorite) throw new Error("ClassPack favorites require an actor-owned item or activity.");
  return queueActorItems(actor, async () => {
    await actor.system.removeFavorite(
      foundry.utils.buildRelativeUuid(item, actor) + (document.item ? `.Activity.${document.id}` : "")
    );
    return document.uuid;
  });
}

function queueActorItems(actor, task) {
  const previous = actorItemQueues.get(actor.uuid) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(task);
  actorItemQueues.set(actor.uuid, operation);
  return operation.finally(() => {
    if (actorItemQueues.get(actor.uuid) === operation) actorItemQueues.delete(actor.uuid);
  });
}

