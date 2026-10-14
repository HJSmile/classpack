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
  const previous = actorItemQueues.get(actor.uuid) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const items = await actor.createEmbeddedDocuments("Item", data, options);
    if (favorite) {
      for (const item of items) await actor.system.addFavorite({
        type: "item", id: foundry.utils.buildRelativeUuid(item, actor)
      });
    }
    return items.map(item => item.uuid);
  });
  actorItemQueues.set(actor.uuid, operation);
  return operation.finally(() => {
    if (actorItemQueues.get(actor.uuid) === operation) actorItemQueues.delete(actor.uuid);
  });
}
