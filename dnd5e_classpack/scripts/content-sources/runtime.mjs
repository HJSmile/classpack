import { MODULE_ID, canonicalUuid, sourceUuid } from "./policy.mjs";

export function installContentFiltering(policy) {
  const browser = dnd5e.applications.CompendiumBrowser, apps = dnd5e.applications.advancement,
    grant = CONFIG.DND5E.advancementTypes.ItemGrant.documentClass,
    choice = CONFIG.DND5E.advancementTypes.ItemChoice.documentClass;
  const installed = [], undo = [], selectionContexts = [];
  function wrap(object, name, factory) {
    const previous = object?.[name];
    if (typeof previous !== "function") throw new Error(`缺少 ${name}`);
    const replacement = factory(previous); object[name] = replacement;
    undo.push(() => { if (object[name] === replacement) object[name] = previous; }); installed.push(name);
  }
  const contextFor = advancement => ({ advancement, actor: advancement.actor,
    classIdentifier: advancement.flags?.[MODULE_ID]?.content?.classIdentifier });
  const isFixed = (advancement, uuid) => {
    const rules = advancement.flags?.[MODULE_ID]?.content;
    if (rules?.kind === "fixed-feature") return true;
    if (advancement.type !== "ItemChoice" && advancement.item?.type === "subclass") return true;
    if (advancement.type === "ItemChoice" || rules?.kind === "spell-list" || rules?.kind === "optional-feature") return false;
    const row = advancement.configuration.items?.find(r => canonicalUuid(r.uuid) === canonicalUuid(uuid));
    return !!row && !row.optional && !advancement.configuration.optional && policy.source(uuid)?.type !== "spell";
  };
  const selectedBefore = advancement => new Set(Object.values(advancement.value?.added ?? {}).flatMap(v => typeof v === "string" ? [canonicalUuid(v)] : Object.values(v).map(canonicalUuid)));
  function prepareBrowse(flow) {
    const previous = flow.options.actions?.browse;
    if (!previous || previous.classpackContentSources) return;
    const replacement = function (...args) {
      selectionContexts.push(contextFor(this.advancement));
      try { return previous.apply(this, args); } finally { selectionContexts.pop(); }
    };
    replacement.classpackContentSources = true;
    flow.options.actions.browse = replacement;
  }
  try {
    wrap(browser, "select", original => function (options = {}, ...rest) {
      const scope = selectionContexts.at(-1);
      return original.call(this, scope ? { ...options, classpackContentContext: scope } : options, ...rest);
    });
    wrap(browser.prototype, "_prepareResultsContext", original => function (context, ...rest) {
      const scope = this.options.classpackContentContext ?? {}, lists = Object.entries(context.filters.additional?.spelllist ?? {}).filter(([, v]) => v === 1).map(([k]) => k);
      const filters = { ...context.filters, additional: { ...context.filters.additional }, arbitrary: [...context.filters.arbitrary ?? []] };
      if (scope.actor && lists.some(l => l.startsWith("class:")) && policy.enabled("EGW") && policy.permitsDunamancy(scope.actor, lists)) {
        filters.additional.spelllist = { ...filters.additional.spelllist, [policy.catalog.dunamancy.list]: 1 };
      }
      const blocked = policy.blocked({ ...scope, lists });
      if (blocked.length) filters.arbitrary.push({ o: "NOT", v: { k: "uuid", o: "in", v: new Set(blocked) } });
      return original.call(this, { ...context, filters }, ...rest);
    });
    wrap(apps.ItemChoiceFlow.prototype, "_prepareContentContext", original => async function (...args) {
      prepareBrowse(this);
      const context = await original.apply(this, args), scope = contextFor(this.advancement);
      context.sections = Array.from(context.sections).map(section => section.isCurrentLevel ? { ...section,
        items: policy.filterCandidates(section.items, scope) } : section);
      const originalCount = Array.from(this.pool ?? []).length;
      this.classpackSourcesEmpty = originalCount > 0 && !context.sections.some(s => s.isCurrentLevel && s.items.length);
      return context;
    });
    wrap(apps.SubclassFlow.prototype, "_prepareContentContext", original => function (...args) { prepareBrowse(this); return original.apply(this, args); });
    wrap(apps.ItemChoiceFlow.prototype, "_onRender", original => async function (...args) {
      await original.apply(this, args);
      if (this.classpackSourcesEmpty) {
        const target = this.element.querySelector('[data-application-part="content"]') ?? this.element;
        const message = document.createElement("p"); message.className = "notification info";
        message.textContent = "当前内容来源设置中没有可用选项，请调整来源设置或使用原有替换选项。"; target.append(message);
      }
    });
    wrap(apps.ItemGrantFlowV2.prototype, "_prepareContentContext", original => async function (...args) {
      const context = await original.apply(this, args), scope = contextFor(this.advancement);
      context.items = context.items.filter(row => row.checked || policy.allowed(row.uuid, { ...scope, fixed: isFixed(this.advancement, row.uuid) }));
      return context;
    });
    wrap(apps.AdvancementManager, "flowsForLevel", original => function (...args) {
      return original.apply(this, args).filter(flow => {
        const advancement = flow.advancement;
        if (advancement.type !== "ItemGrant" || Object.keys(advancement.value ?? {}).length) return true;
        return advancement.configuration.items.some(row => policy.allowed(row.uuid,
          { ...contextFor(advancement), fixed: isFixed(advancement, row.uuid) }));
      });
    });
    wrap(grant.prototype, "apply", original => function (level, data = {}, options = {}) {
      if (data.retainedData?.items?.length || Object.keys(data.retainedData ?? {}).length) return original.call(this, level, data, options);
      const scope = contextFor(this), previous = selectedBefore(this);
      let selected = data.selected;
      if (!selected && options.initial) selected = this.configuration.items?.filter(row => !this.configuration.optional || !row.optional).map(row => row.uuid) ?? [];
      if (!selected) return original.call(this, level, data, options);
      const allowed = selected.filter(uuid => previous.has(canonicalUuid(uuid)) || policy.allowed(uuid, { ...scope, fixed: isFixed(this, uuid) }));
      if (this.type === "ItemChoice" && allowed.length !== selected.length) throw new Error("该条目不符合当前 ClassPack 来源或法表资格设置。");
      return original.call(this, level, { ...data, selected: allowed }, options);
    });
    wrap(choice.prototype, "_validateItemType", original => function (item, options = {}) {
      const restriction = options.restriction ?? this.configuration.restriction;
      const lists = Array.from(restriction.list ?? []);
      if (item?.type === "spell" && lists.some(l => l.startsWith("class:")) && policy.isDunamancy(item)
        && policy.allowed(item, contextFor(this)) && policy.permitsDunamancy(this.actor)) {
        options = { ...options, restriction: { ...restriction, list: new Set([...lists, policy.catalog.dunamancy.list]) } };
      }
      return original.call(this, item, options);
    });
  } catch (error) {
    for (const restore of undo.reverse()) restore();
    console.error(`[${MODULE_ID}] 内容过滤未启用：`, error);
    ui.notifications?.warn?.("ClassPack 内容过滤未启用：当前 dnd 系统接口不匹配，已保留系统原行为。");
    return { active: false, error: error.message };
  }
  return { active: true, installed };
}
