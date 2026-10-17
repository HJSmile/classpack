import { canonicalUuid } from "./content-sources/policy.mjs";

const FEATURE_ID = "jxABfDaC7XGVji2k";
const sourceUuid = item => canonicalUuid(item.flags?.dnd5e?.sourceId ?? item._stats?.compendiumSource);
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function hasCantripFormulas(actor) {
  return actor.isOwner && actor.classes?.wizard?.system.levels >= 3
    && Array.from(actor.items).some(item => sourceUuid(item)?.split(".").at(-1) === FEATURE_ID
      || ["cantrip-formulas", "-cantrip-formulas"].includes(item.system.identifier));
}

export function wizardCantrips(actor) {
  return Array.from(actor.items).filter(item => {
    if (item.type !== "spell" || item.system.level !== 0) return false;
    const originId = item.flags?.dnd5e?.advancementOrigin?.split(".")[0], origin = actor.items.get(originId);
    // A general feat selected through a wizard ASI can inherit its advancement root;
    // that alone must not turn the feat's spells into wizard class spells.
    if (origin?.type === "feat") return origin.system.type?.value === "class" && item.system.classIdentifier === "wizard";
    return item.system.sourceItem === "class:wizard"
      || (origin?.type === "class" && origin.system.identifier === "wizard")
      || (origin?.type === "subclass" && origin.system.classIdentifier === "wizard")
      || (item.system.sourceItem?.startsWith("subclass:") && item.system.classIdentifier === "wizard");
  });
}

export async function replaceWizardCantrip(actor, oldId, uuid) {
  if (!hasCantripFormulas(actor)) throw new Error("角色需要拥有戏法公式，并至少为 3 级法师。");
  uuid = canonicalUuid(uuid);
  const old = wizardCantrips(actor).find(item => item.id === oldId), source = await fromUuid(uuid);
  if (!old || source?.type !== "spell" || source.system.level !== 0
    || !dnd5e.registry.spellLists.forType("class:wizard")?.has(source)) throw new Error("请选择已知法师戏法及另一个法师戏法。");
  if (wizardCantrips(actor).some(item => sourceUuid(item) === uuid)) throw new Error("已经学会这个法师戏法。");
  const origin = old.getFlag("dnd5e", "advancementOrigin"), [ownerId, advancementId] = origin?.split(".") ?? [];
  const owner = actor.items.get(ownerId), advancement = owner?.system.advancement?.[advancementId];
  let ownerData;
  if (origin) {
    if (!advancement || !["ItemChoice", "ItemGrant"].includes(advancement.type)) throw new Error("无法确认该戏法的升级记录，请先检查角色的升级数据。");
    ownerData = owner.toObject();
    const value = ownerData.system.advancement[advancementId].value;
    const slot = advancement.type === "ItemChoice"
      ? Object.values(value.added ?? {}).find(items => old.id in items) : value.added;
    if (!slot || !(old.id in slot)) throw new Error("该戏法与其升级记录不一致，尚未替换。");
    slot[old.id] = uuid;
  }
  const data = game.items.fromCompendium(source);
  data._id = old.id;
  data.sort = old.sort ?? data.sort;
  data.system.ability = "int";
  data.system.method = "spell";
  data.system.prepared = 1;
  data.system.sourceItem = old.system.sourceItem || "class:wizard";
  data.flags ??= {}; data.flags.dnd5e ??= {};
  data.flags.dnd5e.sourceId = uuid;
  for (const key of ["advancementOrigin", "advancementRoot"]) {
    const value = old.getFlag("dnd5e", key);
    if (value) data.flags.dnd5e[key] = value;
  }
  await actor.performBulkUpdate({ item: [data, ...(ownerData ? [ownerData] : [])] },
    { updateOptions: { diff: false, recursive: false } });
}

export function registerCantripFormulas() {
  const pending = new Set(), handled = new WeakSet();
  const callback = async (actor, result) => {
    if (result?.type !== "long" || !actor.isOwner || pending.has(actor.uuid) || handled.has(result)) return;
    if (!hasCantripFormulas(actor)) return;
    handled.add(result); pending.add(actor.uuid);
    try {
      const current = wizardCantrips(actor);
      if (!current.length) return;
      const oldId = await foundry.applications.api.DialogV2.wait({
        window: { title: "戏法公式" },
        content: `<p>长休完成。你可以替换一个已知法师戏法。</p><div class="form-group"><label>替换戏法</label><select name="cantrip">${current.map(i => `<option value="${escape(i.id)}">${escape(i.name)}</option>`).join("")}</select></div>`,
        buttons: [{ action: "replace", label: "选择新戏法", callback: (event, button, dialog) => dialog.element.querySelector('[name="cantrip"]').value },
          { action: "skip", label: "保留现有戏法", default: true, callback: () => null }],
        rejectClose: false
      });
      if (!oldId) return;
      const known = new Set(current.map(sourceUuid).filter(Boolean));
      const result = await dnd5e.applications.CompendiumBrowser.select({
        filters: { locked: { documentClass: "Item", exclusive: true, types: new Set(["spell"]),
          additional: { level: { min: 0, max: 0 }, spelllist: { "class:wizard": 1 } },
          arbitrary: [{ o: "NOT", v: { k: "uuid", o: "in", v: known } }] } },
        classpackContentContext: { actor, classIdentifier: "wizard", lists: ["class:wizard"] },
        selection: { min: 1, max: 1 }
      });
      if (result?.size === 1) await replaceWizardCantrip(actor, oldId, Array.from(result)[0]);
    } finally { pending.delete(actor.uuid); }
  };
  Hooks.on("dnd5e.restCompleted", (actor, result) => {
    callback(actor, result).catch(error => {
      console.error("[dnd5e_classpack] 戏法公式替换未完成", error);
      ui.notifications.error(`戏法公式：${error.message}`);
    });
  });
  return callback;
}
