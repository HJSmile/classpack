import { MODULE_ID } from './utils.mjs';

/** Pure d20 editing and a single, extensible before-publication middleware pipeline. */
export function createRollApi(api) {
  const interceptors = new Map(), pending = new Map();
  let installed = false;
  const clone = data => foundry.utils.deepClone(data);
  function primaryD20(roll) {
    const die = roll.d20 ?? roll.terms?.[0];
    if (die?.faces !== 20 || !die._evaluated || !Array.isArray(die.results)) throw new Error('Expected an evaluated d20 test.');
    return die;
  }
  function d20Candidates(roll, { includeDiscarded = true } = {}) {
    return primaryD20(roll).results.flatMap((result, index) => {
      if (result.rerolled || result.exploded || (!includeDiscarded && !result.active)
        || !Number.isInteger(result.result) || result.result < 1 || result.result > 20) return [];
      return [{ key: `original-${index}`, index, raw: result.result, active: !!result.active }];
    });
  }
  function d20Classes(value, { reveal = true, classes = '' } = {}) {
    const native = reveal ? String(classes).split(/\s+/).filter(name => /^[a-z][\w-]*$/i.test(name)
      && !['discarded', 'rerolled', 'exploded'].includes(name)) : [];
    if (reveal && !classes) {
      if (value === 1) native.push('min');
      else if (value === 20) native.push('max');
    }
    return [...new Set(['roll', 'd20', ...native])].join(' ');
  }
  function d20Display(roll, { reveal = true } = {}) {
    const tooltip = primaryD20(roll).getTooltipData?.();
    const dice = d20Candidates(roll).map(choice => {
      const classes = d20Classes(choice.raw, { reveal, classes: tooltip?.rolls?.[choice.index]?.classes });
      return `<li class="${classes}">${reveal ? choice.raw : '?'}</li>`;
    }).join('');
    return `<div class="dice-tooltip cp-roll-dice"><div class="dice"><ol class="dice-rolls">${dice}</ol></div></div>`;
  }
  function selectD20(original, { additionalResults = [], selected, includeDiscarded = true } = {}) {
    const choices = d20Candidates(original, { includeDiscarded });
    const roll = CONFIG.Dice.D20Roll.fromData(clone(original.toJSON())), die = primaryD20(roll);
    const originalCount = die.results.length;
    additionalResults.forEach(value => {
      if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error('An additional d20 result must be 1–20.');
      const result = { result: value, active: false, discarded: true };
      let counted = value;
      if (Number.isFinite(die.options?.minimum)) counted = Math.max(counted, die.options.minimum);
      if (Number.isFinite(die.options?.maximum)) counted = Math.min(counted, die.options.maximum);
      if (counted !== value) result.count = counted;
      die.results.push(result);
      die.number += 1;
    });
    let index;
    if (selected === 'extra' && additionalResults.length === 1) index = originalCount;
    else if (/^extra-\d+$/.test(selected)) index = originalCount + Number(selected.slice(6));
    else index = choices.find(choice => choice.key === selected)?.index;
    if (!Number.isInteger(index) || index < 0 || index >= die.results.length) throw new Error('Invalid d20 selection.');
    die.results.forEach((result, n) => { result.active = n === index; result.discarded = n !== index; });
    roll.resetFormula();
    roll._total = roll._evaluateTotal();
    if (!Number.isFinite(roll.total) || roll.options.advantageMode !== original.options.advantageMode) throw new Error('Invalid transformed roll.');
    // No evaluate(), reroll() or configureModifiers(): modifiers and all other dice stay intact.
    return roll;
  }
  function replaceD20(original, value) { return selectD20(original, { additionalResults: [value], selected: 'extra' }); }
  function selectD20By(original, { additionalResults = [], strategy = 'highest', includeDiscarded = true } = {}) {
    if (!['highest', 'lowest'].includes(strategy)) throw new Error('Unknown d20 selection strategy.');
    const die = primaryD20(original), direction = strategy === 'highest' ? 1 : -1;
    const candidates = d20Candidates(original, { includeDiscarded }).map(choice => ({
      ...choice, counted: die.results[choice.index].count ?? choice.raw
    }));
    additionalResults.forEach((raw, index) => {
      if (!Number.isInteger(raw) || raw < 1 || raw > 20) throw new Error('An additional d20 result must be 1–20.');
      let counted = raw;
      if (Number.isFinite(die.options?.minimum)) counted = Math.max(counted, die.options.minimum);
      if (Number.isFinite(die.options?.maximum)) counted = Math.min(counted, die.options.maximum);
      candidates.push({ key: additionalResults.length === 1 ? 'extra' : `extra-${index}`, raw, counted, active: false });
    });
    candidates.sort((a, b) => direction * (b.counted - a.counted || b.raw - a.raw)
      || Number(b.active) - Number(a.active));
    const selected = candidates[0]?.key;
    return { roll: selectD20(original, { additionalResults, selected, includeDiscarded }),
      audit: { selected, additionalResults, strategy } };
  }
  async function selectD20Dialog(roll, { additionalResults = [], user, label = '选择 d20', includeDiscarded = true, reveal = true } = {}) {
    const choices = d20Candidates(roll, { includeDiscarded });
    const tooltip = primaryD20(roll).getTooltipData?.();
    const buttons = choices.map((choice, i) => [`原骰 ${i + 1}`, choice.key, {
      value: reveal ? choice.raw : '?', dice: true,
      diceClasses: d20Classes(choice.raw, { reveal, classes: tooltip?.rolls?.[choice.index]?.classes })
    }]);
    additionalResults.forEach((value, i) => buttons.push([
      `额外骰 ${i + 1}`, additionalResults.length === 1 ? 'extra' : `extra-${i}`,
      { value: reveal ? value : '?', dice: true, diceClasses: d20Classes(value, { reveal }) }
    ]));
    const defaultKey = choices.find(choice => choice.active)?.key ?? choices[0]?.key;
    let selected;
    try {
      selected = await api.dialogUtils.buttonDialog(label, '', buttons,
        { userId: user.id, width: 360, compact: true, displayAsRows: false });
    } catch (error) { console.warn(`[${MODULE_ID}] Selection closed or controller disconnected.`, error); }
    if (!buttons.some(button => button[1] === selected)) selected = defaultKey;
    return { roll: selectD20(roll, { additionalResults, selected, includeDiscarded }), audit: { selected, additionalResults } };
  }
  function syncNaturalResults(workflow) {
    const tracker = workflow?.attackRollModifierTracker;
    if (!tracker?.toJSON || !tracker.restore) return;
    const state = clone(tracker.toJSON());
    for (const [key, type, source] of [['critical', 'CRIT', 'naturalCrit'], ['fumble', 'FUMBLE', 'naturalFumble']]) {
      if (state[key]) {
        if (state[key].natural && state.attribution?.[type]?.restored && state[key].override === true) {
          delete state[key].override; delete state.attribution[type].restored;
        }
        state[key].natural = false;
      }
      if (state.attribution?.[type]) delete state.attribution[type][source];
      for (const field of ['legacyAttribution', 'advReminderAttribution']) {
        if (state[field]) state[field] = state[field].filter(value => value !== `${type}:${source}`);
      }
    }
    tracker.restore(state);
    workflow.persistAttackTracker?.();
    workflow.persistFields?.({ isCritical: tracker.isCritical, isFumble: tracker.isFumble });
  }
  function registerInterceptor(id, handler, { priority = 100 } = {}) {
    if (!id || typeof handler !== 'function' || interceptors.has(id)) throw new Error('Interceptor id must be unique.');
    interceptors.set(id, { handler, priority });
    return () => interceptors.delete(id);
  }
  async function dispatch(context) {
    for (const { handler } of [...interceptors.values()].sort((a, b) => a.priority - b.priority)) {
      const result = await handler(context);
      if (result !== undefined) context.roll = result;
    }
    return context.roll;
  }
  function prepare(workflow) {
    if (!workflow?.activity?.uuid) return;
    pending.set(workflow.activity.uuid, workflow);
    if (pending.size > 100) pending.delete(pending.keys().next().value);
  }
  function classify(config) {
    const names = (config.hookNames ?? []).map(name => name.toLowerCase());
    if (names.includes('initiativedialog')) return null;
    for (const [name, type] of [['attack', 'attack'], ['deathsave', 'deathSave'], ['concentration', 'concentration'],
      ['tool', 'tool'], ['skill', 'skill'], ['savingthrow', 'save'], ['abilitycheck', 'check']]) if (names.includes(name)) return type;
    return null;
  }
  async function processRolls(rolls, config, message) {
    if (config.evaluate === false || config.simulate || config.midiOptions?.simulate) return;
    const type = classify(config);
    if (!type) return;
    const workflow = config.workflow ?? config.midiOptions?.workflow ?? pending.get(config.subject?.uuid);
    const actor = config.subject?.documentName === 'Actor' ? config.subject : config.subject?.actor ?? workflow?.actor;
    if (!actor || (type === 'attack' && !workflow)) return;
    for (let index = 0; index < rolls.length; index++) {
      const original = rolls[index];
      if (!original._evaluated || !original.validD20Roll) continue;
      rolls[index] = await dispatch({ roll: original, actor, workflow, activity: config.subject?.item ? config.subject : workflow?.activity,
        targets: type === 'attack' ? [...workflow.targets].map(token => token.actor).filter(Boolean) : [], type,
        rollMode: message.rollMode ?? CONFIG.Dice.BasicRoll.getMessageMode(),
        label: `${actor.name}：${config.subject?.item?.name ?? type}`, config, message });
      if (type === 'attack' && rolls[index] !== original) syncNaturalResults(workflow);
    }
  }
  function install() {
    if (installed || !game.modules.get('midi-qol')?.active || !globalThis.libWrapper || !api.socket) return false;
    libWrapper.register(MODULE_ID, 'CONFIG.Dice.D20Roll.buildEvaluate', async function(wrapped, rolls, config = {}, message = {}) {
      const result = await wrapped(rolls, config, message); await processRolls(rolls, config, message); return result;
    }, 'WRAPPER');
    Hooks.on('midi-qol.preAttackRollConfig', workflow => prepare(workflow));
    Hooks.on('dnd5e.preConfigureInitiative', (actor, config) => {
      config.options ??= {}; config.options.classpackInitiativeActorUuid = actor.uuid;
    });
    libWrapper.register(MODULE_ID, 'CONFIG.Dice.D20Roll.prototype.evaluate', async function(wrapped, options = {}) {
      const result = await wrapped(options), uuid = this.options.classpackInitiativeActorUuid;
      if (!uuid || options.maximize || options.minimize || this.options.classpackInitiativeHandled) return result;
      const actor = await fromUuid(uuid);
      if (!actor) return result;
      const selected = await dispatch({ roll: this, actor, targets: [], type: 'initiative', label: `${actor.name}：先攻`,
        rollMode: this.options.rollMode ?? CONFIG.Dice.BasicRoll.getMessageMode() });
      if (selected !== this) {
        this.terms.splice(0, this.terms.length, ...selected.terms); this._dice = selected._dice ?? [];
        this.options = selected.options; this._total = selected.total; this.resetFormula();
      }
      this.options.classpackInitiativeHandled = true;
      return result;
    }, 'WRAPPER');
    installed = true;
    return true;
  }
  return Object.freeze({ primaryD20, d20Candidates, d20Display, selectD20, selectD20By, replaceD20, selectD20Dialog,
    syncNaturalResults, registerInterceptor, dispatch, prepare, install, get installed() { return installed; } });
}
