export const MODULE_ID = "dnd5e_classpack";
export const canonicalUuid = uuid => uuid?.replace(/^Compendium\.dnd5e_classpack\.([^.]+)\.([A-Za-z0-9]{16})$/, "Compendium.dnd5e_classpack.$1.Item.$2");
export function sourceUuid(entry) {
  return canonicalUuid(typeof entry === "string" ? entry : entry?._stats?.compendiumSource
    ?? entry?.flags?.dnd5e?.sourceId ?? entry?.uuid);
}
export function createContentPolicy(catalog, settings) {
  const dunamancy = new Set(catalog.dunamancy.uuids);
  function enabled(book) {
    return !settings().enabled || !book || settings().sources[book] !== false;
  }
  function source(entry) {
    const uuid = sourceUuid(entry);
    if (!uuid?.startsWith(`Compendium.${MODULE_ID}.`)) return null;
    return catalog.entries[uuid] ?? { book: entry?.system?.source?.book || null, ua: false, thirdParty: false };
  }
  function owned(actor, id) {
    return Array.from(actor?.items ?? []).some(item => sourceUuid(item)?.split(".").at(-1) === id);
  }
  function permitsDunamancy(actor, lists = ["class:wizard"]) {
    return settings().dunamancy || (Array.from(lists).includes("class:wizard") && Array.from(actor?.itemTypes?.subclass ?? [])
      .some(item => catalog.dunamancy.subclasses.includes(item.system.identifier)));
  }
  function allowed(entry, context = {}) {
    const uuid = sourceUuid(entry), meta = source(entry);
    if (!meta) return true;
    if (context.fixed) return true;
    const state = settings();
    if (state.enabled && (!enabled(meta.book) || (meta.ua && !state.ua) || (meta.thirdParty && !state.thirdParty))) return false;
    const rules = context.advancement?.flags?.[MODULE_ID]?.content;
    if (rules?.requiresItem && !owned(context.actor, rules.requiresItem)) return false;
    if (rules?.requires?.some(book => !enabled(book))) return false;
    const lists = context.lists ?? (context.advancement?.configuration?.restriction?.list ?? []);
    const classes = Array.from(lists).filter(l => l.startsWith("class:")).map(l => l.slice(6));
    const classId = context.classIdentifier ?? rules?.classIdentifier;
    if (classId && !classes.includes(classId)) classes.push(classId);
    if (meta.type === "spell" && classes.length) {
      if (dunamancy.has(uuid)) return permitsDunamancy(context.actor, classes.map(c => "class:" + c));
      const qualifications = classes.map(c => meta.spellClasses?.[c]).filter(Boolean);
      if (qualifications.length && !qualifications.some(q => q.requires.every(enabled))) return false;
    }
    return true;
  }
  function blocked(context = {}) {
    const hidden = new Set(Object.keys(catalog.entries).filter(uuid => !allowed(uuid, context)));
    if (settings().enabled) for (const group of catalog.reprints ?? []) {
      const available = group.filter(uuid => !hidden.has(uuid));
      const preferred = available.find(uuid => source(uuid).book === "TCE") ?? available[0];
      for (const uuid of available) if (uuid !== preferred) hidden.add(uuid);
    }
    return Array.from(hidden);
  }
  function filterCandidates(rows, context = {}) {
    let result = rows.filter(row => row.checked || allowed(row.uuid ?? row, context));
    if (!settings().enabled) return result;
    for (const group of catalog.reprints ?? []) {
      const available = result.filter(row => group.includes(sourceUuid(row)));
      const checked = available.filter(row => row.checked);
      const preferred = checked[0] ?? available.find(row => source(row)?.book === "TCE") ?? available[0];
      result = result.filter(row => !available.includes(row) || row.checked || row === preferred);
    }
    return result;
  }
  return Object.freeze({ catalog, source, enabled, allowed, blocked, filterCandidates, owned, permitsDunamancy,
    isDunamancy: entry => dunamancy.has(sourceUuid(entry)) });
}
