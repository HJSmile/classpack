export const MODULE_ID = "dnd5e_classpack";
export function sourceBooks(meta) {
  const books = Array.isArray(meta?.books) ? meta.books : [meta?.book];
  return Array.from(new Set(books.filter(book => typeof book === "string" && book.length)));
}
export const canonicalUuid = uuid => uuid?.replace(/^Compendium\.dnd5e_classpack\.([^.]+)\.([A-Za-z0-9]{16})$/, "Compendium.dnd5e_classpack.$1.Item.$2");
export function sourceUuid(entry) {
  if (typeof entry === "string") return canonicalUuid(entry);
  if (entry?.uuid?.startsWith("Compendium.")) return canonicalUuid(entry.uuid);
  return canonicalUuid(entry?._stats?.compendiumSource
    ?? entry?.flags?.dnd5e?.sourceId ?? entry?.uuid);
}
export function createContentPolicy(catalog, settings) {
  const dunamancy = new Set(catalog.dunamancy.uuids);
  const entries = Object.entries(catalog.entries).map(([uuid, meta]) => ({ uuid, meta, books: sourceBooks(meta) }));
  let lastState, signature, staticAllowed, staticBlocked;
  const enabledIn = (book, state) => !state.enabled || !book || state.sources[book] !== false;
  function publicationAllowed(meta, books, state) {
    return !state.enabled || ((!books.length || books.some(book => enabledIn(book, state)))
      && (!meta.ua || state.ua) && (!meta.thirdParty || state.thirdParty));
  }
  // Cache only publication rules. Actor, class and advancement decisions live for one operation.
  function configuration() {
    const state = settings();
    if (state === lastState && Object.isFrozen(state) && Object.isFrozen(state.sources)) return state;
    const key = JSON.stringify([state.enabled, state.ua, state.thirdParty,
      Object.entries(state.sources).sort(([a], [b]) => a.localeCompare(b))]);
    if (key !== signature) {
      signature = key; staticAllowed = new Map(); staticBlocked = [];
      for (const { uuid, meta, books } of entries) {
        const allowed = !!publicationAllowed(meta, books, state);
        staticAllowed.set(uuid, allowed);
        if (!allowed) staticBlocked.push(uuid);
      }
    }
    lastState = state;
    return state;
  }
  function enabled(book) { return enabledIn(book, settings()); }
  function metadata(entry, uuid) {
    if (!uuid?.startsWith(`Compendium.${MODULE_ID}.`)) return null;
    return catalog.entries[uuid] ?? { book: entry?.system?.source?.book || null, ua: false, thirdParty: false };
  }
  function source(entry) { return metadata(entry, sourceUuid(entry)); }
  function owned(actor, id) {
    return Array.from(actor?.items ?? []).some(item => sourceUuid(item)?.split(".").at(-1) === id);
  }
  function dunamancyPermitted(actor, lists, state) {
    return state.dunamancy || (Array.from(lists).includes("class:wizard") && Array.from(actor?.itemTypes?.subclass ?? [])
      .some(item => catalog.dunamancy.subclasses.includes(item.system.identifier)));
  }
  function permitsDunamancy(actor, lists = ["class:wizard"]) { return dunamancyPermitted(actor, lists, settings()); }
  function operation(context, state) {
    if (context.fixed) return { fixed: true, state };
    const rules = context.advancement?.flags?.[MODULE_ID]?.content;
    const denied = !!((rules?.requiresItem && !owned(context.actor, rules.requiresItem))
      || rules?.requires?.some(book => !enabledIn(book, state)));
    const lists = context.lists ?? (context.advancement?.configuration?.restriction?.list ?? []);
    const classes = Array.from(lists).filter(l => l.startsWith("class:")).map(l => l.slice(6));
    const classId = context.classIdentifier ?? rules?.classIdentifier;
    if (classId && !classes.includes(classId)) classes.push(classId);
    return { state, denied, classes,
      dunamancy: classes.length && dunamancyPermitted(context.actor, classes.map(c => "class:" + c), state) };
  }
  function evaluate(entry, op, uuid = sourceUuid(entry)) {
    const meta = metadata(entry, uuid);
    if (!meta || op.fixed) return true;
    const publication = staticAllowed.has(uuid) ? staticAllowed.get(uuid) : publicationAllowed(meta, sourceBooks(meta), op.state);
    if (!publication || op.denied) return false;
    if (meta.type === "spell" && op.classes.length) {
      if (dunamancy.has(uuid)) return !!op.dunamancy;
      const qualifications = op.classes.map(c => meta.spellClasses?.[c]).filter(Boolean);
      if (qualifications.length && !qualifications.some(q => q.requires.every(book => enabledIn(book, op.state)))) return false;
    }
    return true;
  }
  function allowed(entry, context = {}) {
    const uuid = sourceUuid(entry);
    if (!metadata(entry, uuid) || context.fixed) return true;
    return evaluate(entry, operation(context, configuration()), uuid);
  }
  function blocked(context = {}) {
    const state = configuration(), op = operation(context, state);
    const hidden = op.fixed ? new Set() : !op.denied && !op.classes.length ? new Set(staticBlocked)
      : new Set(entries.filter(({ uuid }) => !evaluate(uuid, op, uuid)).map(({ uuid }) => uuid));
    if (state.enabled) for (const group of catalog.reprints ?? []) {
      const available = group.filter(uuid => !hidden.has(uuid));
      const preferred = available.find(uuid => source(uuid).book === "TCE") ?? available[0];
      for (const uuid of available) if (uuid !== preferred) hidden.add(uuid);
    }
    return Array.from(hidden);
  }
  function filterCandidates(rows, context = {}) {
    const state = configuration(), op = operation(context, state);
    let result = rows.filter(row => row.checked || evaluate(row.uuid ?? row, op));
    if (!state.enabled) return result;
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
