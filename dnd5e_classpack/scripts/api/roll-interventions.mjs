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
            const dice = reveal ? api.rolls.d20Candidates(context.roll).map(choice => choice.raw).join('、') : '隐藏（盲骰）';
            const action = await api.dialogUtils.buttonDialog(`${provider.label}：${candidate.actor.name}`,
              `<p>${escape(context.label)}</p><p>原始 d20：${escape(dice)}。尚未公布结算结果。</p>
               <p>剩余次数：${api.resources.remaining(candidate.item)}。是否使用？消耗 ${candidate.amount ?? 1} 次。</p>
               ${provider.cancelOnMultipleActors ? '<p>多个不同生物同时使用时，各消耗次数并抵消，不产生额外骰。</p>' : ''}`,
              [['使用', 'spend'], ['不使用', 'decline']], { userId: user.id });
            return { ...candidate, user, reveal, spend: action === 'spend' };
          }));
          const spenders = answers.filter(answer => answer.spend);
          let state = candidates.length ? 'declined' : 'unavailable', audit = {};
          if (spenders.length) {
            const receipt = await api.resources.commitLocal(spenders.map(candidate => ({
              itemUuid: candidate.item.uuid, amount: candidate.amount ?? 1
            })));
            receipts.push(receipt);
            if (provider.cancelOnMultipleActors && new Set(spenders.map(candidate => candidate.actor.uuid)).size > 1) {
              state = 'cancelled';
              api.rolls.primaryD20(context.roll).options.flavor = `${provider.label}互相抵消（没有额外骰）`;
            } else {
              const result = await provider.apply(context, { spenders });
              if (Array.isArray(result?.roll?.terms)) context.roll = result.roll;
              else if (Array.isArray(result?.terms)) context.roll = result;
              api.rolls.primaryD20(context.roll);
              audit = result?.audit ?? {}; state = 'selected';
            }
          }
          context.roll.options.classpackInterventions ??= {};
          context.roll.options.classpackInterventions[id] = {
            requestId: request.id, state, spentActors: spenders.map(candidate => candidate.actor.uuid), ...audit
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
      return suppressLegacyChange(this, change) ? false : wrapped(change, options);
    }, 'MIXED');
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
