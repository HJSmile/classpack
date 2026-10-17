import { canonicalUuid } from "./content-sources/policy.mjs";

const MODULE_ID = "dnd5e_classpack";
const rulesFor = advancement => advancement.flags?.[MODULE_ID]?.spellLearning;
const siblings = advancement => Object.values(advancement.item.system.advancement)
  .filter(a => rulesFor(a)?.group === rulesFor(advancement)?.group);

function excludedSpells(advancement) {
  const origins = new Set(siblings(advancement).map(a => `${advancement.item.id}.${a.id}`));
  return new Set([...(rulesFor(advancement).exclude ?? []), ...Array.from(advancement.actor.items)
    .filter(item => origins.has(item.flags?.dnd5e?.advancementOrigin))
    .map(item => canonicalUuid(item.flags?.dnd5e?.sourceId ?? item._stats?.compendiumSource)).filter(Boolean)]);
}

export function canReplaceSpell(advancement, level) {
  if (!rulesFor(advancement)) return true;
  return !siblings(advancement).some(a => a.id !== advancement.id && a.value.replaced?.[level]);
}

// A replaced spell keeps the entitlement of its original learning slot.
export function learningSlot(advancement, id, seen = new Set()) {
  if (seen.has(id)) throw new Error("法术升级的替换记录存在循环。");
  seen.add(id);
  const entry = Object.entries(advancement.value.added ?? {}).find(([, items]) => id in items);
  if (!entry) return null;
  const [level] = entry, replaced = advancement.value.replaced?.[level];
  return replaced?.replacement === id ? learningSlot(advancement, replaced.original, seen) : Number(level);
}

export function replacementSchools(advancement, level) {
  const rules = rulesFor(advancement), replaced = advancement.value.replaced?.[level];
  if (rules?.kind !== "any" || rules.initialAnyReplacement !== false || !replaced || replaced.replacement) return null;
  const slot = learningSlot(advancement, replaced.original);
  if (slot === null) throw new Error("无法确认要替换的法术的学习等级。");
  return slot === 3 ? rules.schools : null;
}

export function installSpellAdvancementRules() {
  const Choice = CONFIG.DND5E.advancementTypes.ItemChoice.documentClass;
  const Flow = dnd5e.applications.advancement.ItemChoiceFlow;
  const Browser = dnd5e.applications.CompendiumBrowser;
  if (Choice.prototype.apply.classpackSpellLearning) return;
  const apply = Choice.prototype.apply, context = Flow.prototype._prepareContentContext, select = Browser.select;
  const browsing = [], queues = new WeakMap();
  function prepareBrowse(flow) {
    const previous = flow.options.actions.browse;
    if (previous.classpackSpellLearning) return;
    const wrapper = function (...args) {
      browsing.push({ advancement: this.advancement, level: this.level });
      try { return previous.apply(this, args); } finally { browsing.pop(); }
    };
    wrapper.classpackSpellLearning = true;
    wrapper.classpackContentSources = previous.classpackContentSources;
    flow.options.actions.browse = wrapper;
  }
  Browser.select = function (options = {}, ...args) {
    const scope = browsing.at(-1), schools = scope && replacementSchools(scope.advancement, scope.level);
    if (scope) options = { ...options, filters: { ...options.filters, locked: { ...options.filters?.locked,
      arbitrary: [...options.filters?.locked?.arbitrary ?? [],
        { o: "NOT", v: { k: "uuid", o: "in", v: excludedSpells(scope.advancement) } }]
    } } };
    if (schools) options = { ...options, selection: { ...options.selection, max: 1 }, filters: {
      ...options.filters, locked: { ...options.filters?.locked, additional: {
        ...options.filters?.locked?.additional, school: Object.fromEntries(schools.map(s => [s, 1]))
      } }
    } };
    return select.call(this, options, ...args);
  };
  Flow.prototype._prepareContentContext = async function (...args) {
    const result = await context.apply(this, args);
    if (rulesFor(this.advancement)) prepareBrowse(this);
    if (rulesFor(this.advancement) && !canReplaceSpell(this.advancement, this.level)) result.replaceable = false;
    return result;
  };
  const wrapped = async function (level, data = {}, options = {}) {
    if (!rulesFor(this)) return apply.call(this, level, data, options);
    const owner = this.item, prior = queues.get(owner) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(async () => {
      if ((data.replace || data.retainedData?.replaced) && !canReplaceSpell(this, level)) {
        throw new Error("本次升级已经替换了一个法术。请先撤销另一组的替换。");
      }
      const selected = data.selected ?? [];
      if (data.replace && selected.length) throw new Error("请先指定要替换的法术，再选择新法术。");
      if (data.replace && learningSlot(this, data.replace) === null) throw new Error("该法术不是由这组选项学会的。");
      const counts = this.getCounts(level);
      if (selected.length > counts.max - counts.current) throw new Error("所选法术超过本次升级的名额。");
      const schools = replacementSchools(this, level);
      if (schools && selected.length > 1) throw new Error("请先单独选择替换法术，再选择本级新增法术。");
      const max = Flow.prototype._maxSpellSlotLevel.call({ advancement: this });
      const excluded = excludedSpells(this), selectedUuids = new Set();
      for (const uuid of selected) {
        const canonical = canonicalUuid(uuid);
        if (excluded.has(canonical) || selectedUuids.has(canonical)) throw new Error("请学习尚未通过该子职业获得的法术。");
        selectedUuids.add(canonical);
        const spell = await fromUuid(uuid);
        if (!spell) throw new Error("找不到所选法术。");
        const restriction = schools ? { ...this.configuration.restriction, school: new Set(schools) }
          : this.configuration.restriction;
        this._validateItemType(spell, { restriction });
        const min = this.configuration.restriction.level === "0" ? 0 : 1;
        if (spell.system.level < min || spell.system.level > max) throw new Error("该法术超出本职业当前可学习的环阶。");
      }
      return apply.call(this, level, data, options);
    });
    queues.set(owner, operation);
    try { return await operation; } finally { if (queues.get(owner) === operation) queues.delete(owner); }
  };
  wrapped.classpackSpellLearning = true;
  Choice.prototype.apply = wrapped;
}
