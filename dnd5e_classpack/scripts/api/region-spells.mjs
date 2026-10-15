const MODULE_ID = "dnd5e_classpack";
const BINDING_FLAG = "regionBinding";

function configOf(item) {
  return item?.flags?.[MODULE_ID]?.regionAutomation;
}

function actorEffects(actor) {
  return Array.from(actor?.appliedEffects ?? actor?.effects ?? []);
}

function activeEffect(effect) {
  return !effect.disabled && !effect.isSuppressed;
}

function fromUuidSafe(uuid) {
  if (!uuid) return null;
  try { return fromUuidSync(uuid, { strict: false }); }
  catch { return null; }
}

function sourceItem(effect) {
  const origin = effect.system?.origin ?? {};
  for (const uuid of [origin.activity, origin.item, effect.origin,
    effect.flags?.[MODULE_ID]?.[BINDING_FLAG]?.sourceItemUuid]) {
    const document = fromUuidSafe(uuid);
    const item = document?.item ?? (document?.documentName === "Item" ? document : null);
    if (item?.actor && configOf(item)) return item;
  }
  return null;
}

function isBindingFrom(effect, item, key) {
  if (!activeEffect(effect)) return false;
  const binding = effect.flags?.[MODULE_ID]?.[BINDING_FLAG];
  if (binding?.sourceItemUuid === item.uuid && binding.key === key) return true;
  const role = effect.flags?.[MODULE_ID]?.regionEffect;
  if (role !== `${key}-binding`) return false;
  return [effect.origin, ...Object.values(effect.system?.origin ?? {}),
    effect._stats?.duplicateSource].some(uuid =>
    typeof uuid === "string" && (uuid === item.uuid || uuid.startsWith(`${item.uuid}.`)));
}

function hasBinding(actor, item, key) {
  return actorEffects(actor).some(effect => isBindingFrom(effect, item, key));
}

function regionsForItem(item, scene) {
  const scenes = scene ? [scene] : Array.from(game.scenes ?? []);
  return scenes.flatMap(scene => Array.from(scene.regions ?? []))
    .filter(region => region.flags?.[MODULE_ID]?.regionAutomation?.sourceItemUuid === item.uuid);
}

function regionForWorkflow(workflow) {
  const target = Array.from(workflow.targets ?? [])[0];
  const document = target?.document ?? target;
  return regionsForItem(workflow.item, document?.parent)[0];
}

function isExempt(actor, region) {
  return !!region?.flags?.[MODULE_ID]?.regionAutomation?.exemptActorUuids?.includes(actor?.uuid);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function chooseExemptions(workflow) {
  const tokens = Array.from(canvas.tokens?.placeables ?? [])
    .filter(token => token.actor && (token.isVisible ?? token.visible ?? false));
  const seen = new Set();
  const rows = tokens.filter(token => !seen.has(token.actor.uuid) && seen.add(token.actor.uuid));
  const content = `<p>选择本次灵体卫士不影响的生物。默认包含施法者。</p>` + rows.map((token, index) =>
    `<label style="display:block"><input type="checkbox" name="exempt" value="${index}"` +
    `${token.actor.uuid === workflow.actor.uuid ? " checked" : ""}> ${escapeHTML(token.name)}</label>`
  ).join("");
  return foundry.applications.api.DialogV2.wait({
    window: { title: "灵体卫士：不受影响的生物" }, content,
    buttons: [{ action: "cast", label: "施法", default: true,
      callback: (_event, _button, dialog) => Array.from(
        dialog.element.querySelectorAll('input[name="exempt"]:checked'))
        .map(input => rows[Number(input.value)].actor.uuid)
    }, { action: "cancel", label: "取消", callback: () => null }],
    rejectClose: false
  });
}

async function setupRegion(workflow, config) {
  const repeated = workflow.item.system.activities.get(config.repeated);
  if (!repeated) throw new Error(`Classpack region activity is missing: ${config.repeated}`);
  for (const uuid of workflow.templateUuids ?? []) {
    const region = await fromUuid(uuid);
    if (region?.documentName !== "Region") continue;
    const behavior = region.behaviors.find(behavior =>
      behavior.type === "midi-qol.regionActivity" &&
      behavior.system.sourceItemUuid === workflow.item.uuid);
    if (!behavior) throw new Error(`Midi region behavior is missing on ${region.uuid}`);
    const rules = foundry.utils.deepClone(behavior.system.rules);
    if (!rules.some(rule => rule.trigger === "entry" && rule.action === "useActivity"
      && rule.targetUuid === repeated.uuid)) {
      rules.push({ trigger: "entry", action: "useActivity", targetUuid: repeated.uuid });
    }
    const extraBehaviors = [];
    if (config.terrain && !region.behaviors.some(b => b.type === "dnd5e.difficultTerrain")) {
      extraBehaviors.push({ name: `${workflow.item.name}：困难地形`, type: "dnd5e.difficultTerrain",
        system: { magical: true, types: [], ignoredDispositions: [] } });
    }
    if (config.key === "spiritGuardians" && !region.behaviors.some(b =>
      b.flags?.[MODULE_ID]?.regionEffect === "spiritGuardians-slow")) {
      const effect = workflow.item.effects.get(config.slowEffect);
      if (!effect) throw new Error("Spirit Guardians slowing effect is missing");
      extraBehaviors.push({ name: "灵体卫士：区域内减速", type: "dnd5e.applyActiveEffect",
        system: { effects: [effect.uuid], dispositions: [], sizes: [], types: [] },
        flags: { [MODULE_ID]: { regionEffect: "spiritGuardians-slow" } } });
    }
    await MidiQOL.socket().executeAsGM("setupRegion", {
      regionUuid: region.uuid,
      update: {
        [`flags.${MODULE_ID}.regionAutomation`]: {
          key: config.key, sourceItemUuid: workflow.item.uuid,
          exemptActorUuids: workflow._classpackExemptActorUuids ?? []
        },
        behaviors: [{ _id: behavior.id, system: { rules } }]
      },
      behaviors: extraBehaviors
    });
  }
}

async function removeWebBinding(workflow) {
  for (const target of workflow.targets ?? []) {
    const effects = actorEffects(target.actor).filter(effect =>
      isBindingFrom(effect, workflow.item, "web"));
    if (effects.length) await MidiQOL.removeEffects({
      actorUuid: target.actor.uuid, effects: effects.map(effect => effect.id)
    });
  }
}

function blackAtTurnStart(workflow, actor) {
  const combat = game.combat;
  const snapshot = combat?.flags?.[MODULE_ID]?.blackAtTurnStart;
  return snapshot?.turn === `${combat?.round}.${combat?.turn}`
    && snapshot.actorUuid === actor.uuid && snapshot.items.includes(workflow.item.uuid);
}

async function handle({ workflow, args }) {
  const config = configOf(workflow?.item);
  if (!config) return;
  const pass = args?.[0]?.macroPass;
  const activityId = workflow.activity?.id;
  if (pass === "preItemRoll" && activityId === config.main && config.key === "spiritGuardians") {
    const choices = await chooseExemptions(workflow);
    if (!Array.isArray(choices)) return false;
    workflow._classpackExemptActorUuids = choices;
  }
  if (pass === "templatePlaced" && activityId === config.main) {
    await setupRegion(workflow, config);
  }
  if (pass === "postSave" && config.key === "grease") {
    const actors = new Map(Array.from(workflow.failedSaves ?? [])
      .filter(token => token.actor).map(token => [token.actor.uuid, token.actor]));
    for (const actor of actors.values()) {
      await MidiQOL.socket().executeAsGM("toggleStatusEffect", {
        actorUuid: actor.uuid, statusId: "prone", options: { active: true }
      });
    }
  }
  if (pass === "preActiveEffects" && activityId === config.cleanup) {
    await removeWebBinding(workflow);
  }
  if (pass !== "preItemRoll" || activityId !== config.repeated) return;
  const target = Array.from(workflow.targets ?? [])[0];
  if (!target?.actor) return false;
  if (config.key === "web" && game.combat?.active) {
    const token = target.document ?? target;
    if (game.combat.combatant?.token?.uuid !== token.uuid) return false;
  }
  if (config.key === "spiritGuardians" && isExempt(target.actor, regionForWorkflow(workflow))) return false;
  if (config.key === "blackTentacles" &&
    (hasBinding(target.actor, workflow.item, config.key) || blackAtTurnStart(workflow, target.actor))) return false;
}

function prepareEffect(effect) {
  const actor = effect.parent;
  if (actor?.documentName !== "Actor") return;
  const role = effect.flags?.[MODULE_ID]?.regionEffect;
  if (!role) return;
  if (role === "spiritGuardians-slow") {
    const behavior = fromUuidSafe(effect.system?.origin?.behavior ?? effect.origin);
    const region = behavior?.region ?? behavior?.parent;
    if (isExempt(actor, region)) return false;
    return;
  }
  if (!["web-binding", "blackTentacles-binding"].includes(role)) return;
  const item = sourceItem(effect);
  const config = configOf(item);
  if (!config) return;
  if (hasBinding(actor, item, config.key)) return false;
  const activity = fromUuidSafe(effect.system?.origin?.activity);
  const dc = Number(activity?.save?.dc?.value ?? item.actor.system.attributes?.spell?.dc);
  const region = regionsForItem(item)[0];
  const changes = foundry.utils.deepClone(effect.system.changes);
  const combat = game.combat;
  const boundTurn = combat?.active ? `${combat.round}.${combat.turn}` : null;
  for (const change of changes) {
    if (!change.key.startsWith("flags.midi-qol.OverTime") || typeof change.value !== "string") continue;
    if (Number.isFinite(dc) && dc > 0) change.value = change.value.replace(/saveDC=@attributes\.spell\.dc\b/g, `saveDC=${dc}`);
    if (config.key === "blackTentacles" && boundTurn && !/\bapplyCondition=/.test(change.value)) {
      change.value += ", applyCondition=effect.flags.dnd5e_classpack.regionBinding.boundTurn !== (String(game.combat.round) + '.' + String(game.combat.turn))";
    }
  }
  effect.updateSource({
    [`flags.${MODULE_ID}.${BINDING_FLAG}`]: {
      key: config.key, sourceItemUuid: item.uuid, regionUuid: region?.uuid ?? null,
      boundTurn, saveDC: Number.isFinite(dc) ? dc : null
    },
    "system.changes": changes,
    "system.origin.item": item.uuid
  });
}

function snapshotBlackBindings(combat, changed) {
  if (!("turn" in changed) && !("round" in changed)) return;
  const turn = changed.turn ?? combat.turn;
  const round = changed.round ?? combat.round;
  const actor = combat.turns?.[turn]?.actor;
  const items = actorEffects(actor).filter(effect => activeEffect(effect)
    && effect.flags?.[MODULE_ID]?.[BINDING_FLAG]?.key === "blackTentacles")
    .map(effect => effect.flags[MODULE_ID][BINDING_FLAG].sourceItemUuid);
  if (!items.length && !combat.flags?.[MODULE_ID]?.blackAtTurnStart) return;
  foundry.utils.setProperty(changed, `flags.${MODULE_ID}.blackAtTurnStart`, {
    turn: `${round}.${turn}`, actorUuid: actor?.uuid ?? null, items: [...new Set(items)]
  });
}

async function cleanupRegionBindings(region) {
  if (!game.user.isGM || (game.users.activeGM && game.users.activeGM.id !== game.user.id)) return;
  if (!region.flags?.[MODULE_ID]?.regionAutomation) return;
  const actors = new Map(Array.from(game.actors ?? []).map(actor => [actor.uuid, actor]));
  for (const scene of game.scenes ?? []) for (const token of scene.tokens ?? []) {
    if (token.actor) actors.set(token.actor.uuid, token.actor);
  }
  for (const actor of actors.values()) {
    const ids = actorEffects(actor).filter(effect =>
      effect.flags?.[MODULE_ID]?.[BINDING_FLAG]?.regionUuid === region.uuid).map(effect => effect.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}

Hooks.on("preCreateActiveEffect", prepareEffect);
Hooks.on("preUpdateCombat", snapshotBlackBindings);
Hooks.on("deleteRegion", cleanupRegionBindings);
Hooks.once("ready", () => {
  const api = game.modules.get(MODULE_ID)?.api;
  if (api) api.regionSpells = { handle };
});

export { handle, prepareEffect, snapshotBlackBindings, cleanupRegionBindings, isBindingFrom,
  setupRegion, hasBinding, isExempt };
