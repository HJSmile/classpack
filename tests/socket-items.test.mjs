import assert from "node:assert/strict";
import { test } from "node:test";

const { createActorItems, createActorItemsOnGM } = await import(process.env.CLASSPACK_ITEMS_URL
  ?? new URL("../dnd5e_classpack/scripts/api/actor-items.mjs", import.meta.url).href);

function fixture() {
  const events = [];
  let serial = 0;
  const actor = {
    documentName: "Actor", uuid: "Actor.target", isOwner: false,
    system: {
      favorites: [{ type: "item", id: ".Item.old", sort: 100000 }],
      async addFavorite(entry) {
        assert.equal(game.user.isGM, true, "favorites are updated by GM");
        const before = [...this.favorites];
        await Promise.resolve();
        this.favorites = [...before, { ...entry, sort: before.at(-1).sort + 100000 }];
        events.push(`favorite:${entry.id}`);
      }
    },
    async createEmbeddedDocuments(type, data, options) {
      assert.equal(game.user.isGM, true, "unowned target is only written by GM");
      assert.equal(type, "Item");
      assert.equal("favorite" in options, false);
      events.push("create");
      return data.map(entry => ({ ...entry, id: `item${++serial}`, uuid: `${this.uuid}.Item.item${serial}` }));
    }
  };
  globalThis.game = { user: { id: "gm", isGM: true } };
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  globalThis.foundry = { utils: { buildRelativeUuid(item, parent) {
    assert.equal(parent, actor);return `.Item.${item.id}`;
  } } };
  globalThis.dnd5eClasspack = { socket: null };
  return { actor, events };
}

test("GM creates multiple items and appends native favorites without dropping existing entries", async () => {
  const { actor } = fixture();
  const uuids = await createActorItems(actor, [{ name: "A" }, { name: "B" }], { favorite: true });
  assert.deepEqual(uuids, ["Actor.target.Item.item1", "Actor.target.Item.item2"]);
  assert.deepEqual(actor.system.favorites.map(f => f.id), [".Item.old", ".Item.item1", ".Item.item2"]);
  assert.deepEqual(actor.system.favorites.map(f => f.sort), [100000, 200000, 300000]);
});

test("player forwards creation and favorites together, using a serializable Actor UUID", async () => {
  const { actor } = fixture();
  game.user = { id: "player", isGM: false };
  let requests = 0;
  dnd5eClasspack.socket = { async executeAsGM(handler, uuid, data, options) {
    requests++;
    assert.equal(handler, "createActorItems");assert.equal(uuid, actor.uuid);
    const requester = game.user;game.user = { id: "gm", isGM: true };
    try { return await createActorItemsOnGM(uuid, data, options); }
    finally { game.user = requester; }
  } };
  assert.deepEqual(await createActorItems(actor, { name: "Breath" }, { favorite: true }), ["Actor.target.Item.item1"]);
  assert.equal(requests, 1);assert.equal(game.user.id, "player");
  assert.equal(actor.system.favorites.at(-1).id, ".Item.item1");
});

test("favorite is optional and ordinary document creation options are forwarded", async () => {
  const { actor } = fixture();
  actor.createEmbeddedDocuments = async (type, data, options) => {
    assert.deepEqual(options, { keepId: true });
    return [{ uuid: "Actor.target.Item.kept" }];
  };
  assert.deepEqual(await createActorItems(actor.uuid, [{ name: "A" }], { keepId: true }), ["Actor.target.Item.kept"]);
  assert.equal(actor.system.favorites.length, 1);
});

test("concurrent grants to the same actor serialize creation and favorites", async () => {
  const { actor, events } = fixture();
  await Promise.all([createActorItems(actor, { name: "A" }, { favorite: true }),
    createActorItems(actor, { name: "B" }, { favorite: true })]);
  assert.deepEqual(events, ["create", "favorite:.Item.item1", "create", "favorite:.Item.item2"]);
  assert.equal(actor.system.favorites.length, 3);
});

test("a failed request does not block later item creation", async () => {
  const { actor } = fixture();
  const create = actor.createEmbeddedDocuments.bind(actor);
  let first = true;
  actor.createEmbeddedDocuments = (...args) => {
    if (first) { first = false;throw new Error("Invalid item data"); }
    return create(...args);
  };
  const results = await Promise.allSettled([createActorItems(actor, { name: "bad" }),
    createActorItems(actor, { name: "good" }, { favorite: true })]);
  assert.equal(results[0].status, "rejected");assert.equal(results[1].status, "fulfilled");
  assert.equal(actor.system.favorites.length, 2);
});

test("handler rejects non-GM execution and invalid target UUIDs; missing socket fails clearly", async () => {
  const { actor } = fixture();
  game.user.isGM = false;
  await assert.rejects(createActorItemsOnGM(actor.uuid, []), /GM client/);
  await assert.rejects(createActorItems(actor, {}), /socketlib/);
  game.user.isGM = true;
  await assert.rejects(createActorItems("Item.notActor", {}), /Actor UUID/);
});
