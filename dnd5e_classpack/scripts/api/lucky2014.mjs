import { MODULE_ID } from './utils.mjs';

/** Lucky contains only identity, eligibility and its extra-d20/cancellation rule. */
export function registerLucky2014(api) {
  const id = 'lucky2014', setting = 'lucky2014Automation', version = '2.0.0';
  api.automations.register({
    id, version, rules: '2014', itemTypes: ['feat'], itemKinds: ['feat'], legacyBinding: 'lucky2014',
    legacyEnabled: item => item.flags?.world?.lucky2014?.enabled === true,
    identifiers: ['lucky'], explicitIdentifiers: ['lucky-2014', 'lucky2014'],
    sourceUuids: ['Compendium.dnd5e_classpack.feats-all.Item.Zxh8VEiQwezfcnvk'], names: ['幸运', '幸运 Lucky', 'Lucky'],
    uses: { max: '3', recovery: [{ period: 'lr', type: 'recoverAll' }] }
  });
  const enabled = () => game.modules.get('midi-qol')?.active && game.settings.get(MODULE_ID, setting) === true;
  const selectionStrategy = (context, spender) => game.settings.get(MODULE_ID, 'lucky2014AutomaticSelection') === true
    ? (context.type === 'attack' && spender.actor.uuid !== context.actor.uuid ? 'lowest' : 'highest') : null;
  api.rollInterventions.register({
    id, automationId: id, label: '幸运', enabled, cancelOnMultipleActors: true, selectionStrategy,
    types: ['attack', 'check', 'save', 'skill', 'tool', 'concentration', 'deathSave', 'initiative'],
    collect(context) {
      const actors = new Map([context.actor, ...(context.type === 'attack' ? context.targets : [])].map(actor => [actor.uuid, actor]));
      return [...actors.values()].flatMap(actor => {
        const item = api.automations.find(actor, id);
        return item ? [{ actor, item, amount: 1 }] : [];
      });
    },
    async apply(context, { spenders }) {
      const extra = (await new Roll('1d20').evaluate({ allowInteractive: false })).total;
      const spender = spenders[0];
      const strategy = selectionStrategy(context, spender);
      if (strategy) return api.rolls.selectD20By(context.roll, { additionalResults: [extra], strategy });
      const result = await api.rolls.selectD20Dialog(context.roll, {
        additionalResults: [extra], user: spender.user, label: `幸运选骰 · ${spender.actor.name}`, reveal: spender.reveal
      });
      return result;
    },
    suppressLegacyChange(effect, change) {
      const item = effect.item ?? (effect.parent?.documentName === 'Item' ? effect.parent : null);
      if (!api.automations.match(item, id).matched) return false;
      return change.key?.startsWith('flags.midi-qol.optional.')
        || (change.key === 'flags.midi-qol.onUseMacroName' && /Lucky2014-OnUse/.test(String(change.value)));
    }
  });
  function registerSettings() {
    game.settings.register(MODULE_ID, setting, {
      name: '幸运专长（2014）自动化', hint: '自动匹配2014版幸运并在检定结算前询问和选骰。更改后刷新客户端。',
      scope: 'world', config: true, type: Boolean, default: true, requiresReload: true
    });
    game.settings.register(MODULE_ID, 'lucky2014AutomaticSelection', {
      name: '幸运自动选骰', hint: '自己的检定取高，受击时取低；关闭后手动选骰。',
      scope: 'world', config: true, type: Boolean, default: true
    });
  }
  function prepareLegacyBridge() {
    if (!enabled()) return;
    if (globalThis.Lucky2014 && globalThis.Lucky2014.integration !== MODULE_ID) globalThis.Lucky2014.uninstall?.();
    globalThis.Lucky2014 = { version: '1.0.0', integration: MODULE_ID,
      prepare: api.rolls.prepare, candidates: api.rolls.d20Candidates,
      chooseDie: (roll, extra, selected) => api.rolls.selectD20(roll, { additionalResults: [extra], selected }) };
  }
  return Object.freeze({ version, registerSettings, prepareLegacyBridge,
    match: item => api.automations.match(item, id), findItem: actor => api.automations.find(actor, id),
    configure: (item, options) => api.automations.configure(item, id, options), remaining: api.resources.remaining,
    get installed() { return api.rolls.installed && api.rollInterventions.installed; },
    inspect(actor) {
      return { installed: api.rolls.installed, enabled: enabled(), items: Array.from(actor.items).map(item => ({
        uuid: item.uuid, name: item.name, ...api.automations.match(item, id), remaining: api.resources.remaining(item)
      })).filter(item => item.matched) };
    }
  });
}
