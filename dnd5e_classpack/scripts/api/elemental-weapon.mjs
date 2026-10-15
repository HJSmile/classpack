/** Apply a cast's elemental choice when a weapon is dropped on the native enchantment card. */
const MODULE_ID = "dnd5e_classpack";
const TYPES = new Set(["acid", "cold", "fire", "lightning", "thunder"]);
const MANAGED_CHANGES = new Set(["name", "activities[attack].attack.bonus", "activities[attack].damage.parts", "system.properties"]);

export function prepareElementalWeapon(target, data, { activity, chatMessage } = {}) {
  const item = activity?.item;
  const elementalWeapon = item?.system?.identifier === "elemental-weapon"
    || item?.id === "srjt2KPpCAtQGe7W"
    || [item?._stats?.compendiumSource, item?._stats?.duplicateSource]
      .some(uuid => uuid?.endsWith(".srjt2KPpCAtQGe7W"));
  if (!elementalWeapon || activity.type !== "enchant") return;
  const state = chatMessage?.getFlag(MODULE_ID, "elementalWeapon");
  if (!state) {
    // Existing multi-profile spells retain their ordinary native behavior.
    if (Array.from(activity.effects ?? []).length !== 1) return;
    ui.notifications.warn("元素武器：请先通过 On Use 宏选择伤害类型，再将武器拖入聊天卡片。");
    return false;
  }
  if (state.version !== 1 || !TYPES.has(state.damageType)
    || !Number.isInteger(state.castLevel) || state.castLevel < 3 || state.castLevel > 9
    || state.activityUuid !== activity.uuid || state.profileId !== data.flags?.dnd5e?.enchantmentProfile
    || target.type !== "weapon" || data.type !== "enchantment") {
    ui.notifications.warn("元素武器：聊天卡片的施法数据与附魔不匹配，请重新施法。");
    return false;
  }
  const bonus = Math.min(3, Math.floor((state.castLevel - 1) / 2));
  const label = game.i18n.localize(CONFIG.DND5E.damageTypes[state.damageType].label);
  const changes = [
    ["name", `（元素武器：${label} +${bonus}）`],
    ["activities[attack].attack.bonus", String(bonus)],
    ["activities[attack].damage.parts", { number: bonus, denomination: 4, types: [state.damageType] }],
    ["system.properties", "mgc"]
  ].map(([key, value]) => ({ _id: foundry.utils.randomID(), key, value, type: "add",
    phase: "initial", priority: 20, conditions: "{}", replacement: "" }));
  data.system.changes = [...(data.system.changes ?? []).filter(change => !MANAGED_CHANGES.has(change.key)), ...changes];
  data.duration = { ...data.duration, value: 1, units: "hours", expiry: "turnStart", expired: false };
}

Hooks.on("dnd5e.preApplyEnchantment", prepareElementalWeapon);
