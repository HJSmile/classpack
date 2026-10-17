import { MODULE_ID } from './utils.mjs';

/** Rule providers run on the GM; generic infrastructure owns routing, prompts and resource commits. */
export function createRollInterventionApi(api) {
  const providers = new Map(), completed = new Map();
  let installed = false, filterInstalled = false;
  const clone = value => foundry.utils.deepClone(value);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const isEnabled = provider => provider.enabled?.() !== false;
  function register(provider) {
    if (!provider.id || providers.has(provider.id) || typeof provider.collect !== 'function' || typeof provider.apply !== 'function') {
      throw new Error('An intervention needs a unique id, collect(context), and apply(context, decisions).');
    }
    providers.set(provider.id, Object.freeze({ priority: 100, ...provider }));
    return () => providers.delete(provider.id);
  }
  async function collect(provider, context) {
    if (!isEnabled(provider) || (provider.types && !provider.types.includes(context.type))) return [];
    const candidates = await provider.collect(context), seen = new Set();
    return candidates.filter(candidate => {
      const key = `${candidate.actor.uuid}:${candidate.item.uuid}`;
      const amount = candidate.amount ?? 1;
      const available = api.resources.remaining(candidate.item);
      if (seen.has(key) || !Number.isInteger(amount) || amount < 0 || !Number.isFinite(available) || available < amount) return false;
      seen.add(key); return true;
    });
  }
  async function beforePublish(context) {
    const ids = [];
    for (const provider of [...providers.values()].sort((a, b) => a.priority - b.priority)) {
      if (!context.roll.options.classpackInterventions?.[provider.id] && (await collect(provider, context)).length) ids.push(provider.id);
    }
    if (!ids.length) return;
    const gm = game.users.activeGM;
    if (!gm || !api.socket) throw new Error('Roll interventions require an online GM and ClassPack socket.');
    const data = await api.socket.executeAsUser('rollInterventionResolve', gm.id, {
      id: foundry.utils.randomID(), requester: game.user.id, actorUuid: context.actor.uuid,
      targetActorUuids: context.targets.map(actor => actor.uuid), activityUuid: context.activity?.uuid,
      providerIds: ids, type: context.type, rollMode: context.rollMode, label: context.label,
      roll: clone(context.roll.toJSON())
    });
    return CONFIG.Dice.D20Roll.fromData(data);
  }
  async function resolve(request) {
    return api.resources.runExclusive(async () => {
      if (!game.user.isGM) throw new Error('Roll interventions must resolve on the GM.');
      const actor = await fromUuid(request.actorUuid), requester = game.users.get(request.requester);
      if (!actor || actor.documentName !== 'Actor' || !requester?.active
        || (!requester.isGM && !actor.testUserPermission(requester, 'OWNER'))) throw new Error('No permission to submit this roll.');
      if (!request.id) throw new Error('Missing intervention request id.');
      const key = `${requester.id}:${request.id}`;
      if (completed.has(key)) return completed.get(key);
      const targets = (await Promise.all((request.targetActorUuids ?? []).map(uuid => fromUuid(uuid))))
        .filter(target => target?.documentName === 'Actor');
      const context = { actor, targets, activity: request.activityUuid ? await fromUuid(request.activityUuid) : null,
        type: request.type, rollMode: request.rollMode, label: request.label,
        roll: CONFIG.Dice.D20Roll.fromData(clone(request.roll)) };
      api.rolls.primaryD20(context.roll);
      const receipts = [];
      try {
        for (const id of request.providerIds) {
          const provider = providers.get(id);
          if (!provider) throw new Error(`Unregistered intervention: ${id}`);
          if (context.roll.options.classpackInterventions?.[id]) continue;
          const candidates = await collect(provider, context);
          const answers = await Promise.all(candidates.map(async candidate => {
            const user = api.firstOwner(candidate.actor) ?? game.users.activeGM;
            if (!user?.active) throw new Error('The decision controller disconnected.');
            const reveal = user.isGM || !['blind', 'blindroll'].includes(context.rollMode);
            const dice = api.rolls.d20Display(context.roll, { reveal });
            const strategy = provider.selectionStrategy?.(context, candidate);
            const useLabel = strategy === 'highest' ? '使用（取高）' : strategy === 'lowest' ? '使用（取低）' : '使用';
            const actorPrefix = `${context.actor.name}：`;
            const rollLabel = String(context.label ?? context.type);
            const detail = context.activity?.item?.name ?? (rollLabel.startsWith(actorPrefix)
              ? rollLabel.slice(actorPrefix.length) : rollLabel);
            const subject = candidate.actor.uuid === context.actor.uuid ? detail : `${context.actor.name} · ${detail}`;
            const action = await api.dialogUtils.buttonDialog(`${provider.label} · ${candidate.actor.name}`,
              `<div class="cp-roll-context"><span>${escape(subject)}</span><span class="cp-roll-remaining">剩余 ${api.resources.remaining(candidate.item)}</span></div>
               ${dice}`,
              [[useLabel, 'spend', { tooltip: `消耗 ${candidate.amount ?? 1} 次` }], ['跳过', 'decline']],
              { userId: user.id, width: 360, compact: true, displayAsRows: false });
            return { ...candidate, user, reveal, spend: action === 'spend' };
          }));
          const spenders = answers.filter(answer => answer.spend);
          const originalDie = api.rolls.primaryD20(context.roll);
          const original = {
            originalFormula: context.roll.formula,
            originalD20Formula: originalDie.formula,
            originalAdvantageMode: context.roll.options.advantageMode,
            originalCount: originalDie.results.length,
            originalResults: api.rolls.d20Candidates(context.roll).map(({ index, raw }) => ({ index, raw }))
          };
          let state = candidates.length ? 'declined' : 'unavailable', audit = {};
          if (spenders.length) {
            const receipt = await api.resources.commitLocal(spenders.map(candidate => ({
              itemUuid: candidate.item.uuid, amount: candidate.amount ?? 1
            })));
            receipts.push(receipt);
            if (provider.cancelOnMultipleActors && new Set(spenders.map(candidate => candidate.actor.uuid)).size > 1) {
              state = 'cancelled';
            } else {
              const result = await provider.apply(context, { spenders });
              if (Array.isArray(result?.roll?.terms)) context.roll = result.roll;
              else if (Array.isArray(result?.terms)) context.roll = result;
              api.rolls.primaryD20(context.roll);
              audit = result?.audit ?? {}; state = 'selected';
            }
          }
          context.roll.options.classpackInterventions ??= {};
          const selectedIndex = api.rolls.primaryD20(context.roll).results.findIndex(result => result.active && !result.rerolled);
          const selectedResult = api.rolls.primaryD20(context.roll).results[selectedIndex];
          context.roll.options.classpackInterventions[id] = {
            requestId: request.id, label: provider.label ?? id, state,
            spentActors: spenders.map(candidate => candidate.actor.uuid), ...original, ...audit,
            selectedIndex, selectedResult: selectedResult?.result,
            selectedCounted: selectedResult?.count ?? selectedResult?.result
          };
        }
      } catch (error) {
        for (const receipt of receipts.reverse()) await api.resources.refundLocal(receipt);
        throw error;
      }
      const result = context.roll.toJSON();
      completed.set(key, result);
      if (completed.size > 1000) completed.delete(completed.keys().next().value);
      return result;
    });
  }
  function suppressLegacyChange(effect, change) {
    if (!installed || !api.rolls.installed || !api.socket) return false;
    return [...providers.values()].some(provider => isEnabled(provider) && provider.suppressLegacyChange?.(effect, change));
  }
  function installEffectFilter() {
    if (filterInstalled || !game.modules.get('midi-qol')?.active || !globalThis.libWrapper) return false;
    libWrapper.register(MODULE_ID, 'CONFIG.ActiveEffect.documentClass.prototype.shouldApplyChange', function(wrapped, change, options) {
      const applicable = wrapped(change, options);
      return suppressLegacyChange(this, change) ? false : applicable;
    }, 'WRAPPER');
    filterInstalled = true; return true;
  }
  function install() {
    if (installed) return false;
    api.rolls.registerInterceptor('classpack.interventions', beforePublish);
    installed = true; return true;
  }
  function refreshActors() {
    const actors = new Map([...(game.actors ?? []), ...(canvas.tokens?.placeables ?? []).map(token => token.actor)]
      .filter(Boolean).map(actor => [actor.uuid, actor]));
    for (const actor of actors.values()) if ([...providers.values()].some(provider => provider.automationId
      && isEnabled(provider) && api.automations.find(actor, provider.automationId))) actor.prepareData();
  }
  return Object.freeze({ register, beforePublish, resolve, install, installEffectFilter, refreshActors,
    suppressLegacyChange, get installed() { return installed; } });
}
