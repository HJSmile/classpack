const OLD = "Compendium.dnd5e_classpack.new-icon.";
const NEW = "Compendium.dnd5e_classpack.spell.";
export function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k) && equal(a[k],b[k]));
}
export function fieldState(object, path) {
  const parts = path.split(".");
  for (const key of parts) {
    if (!object || !Object.hasOwn(object,key)) return {present: false};
    object = object[key];
  }
  return {present: true, value: object};
}
export function updateField(path, state) {
  if (state.present) return {[path]: structuredClone(state.value)};
  const parts = path.split("."), key = parts.pop();
  return {[parts.length ? `${parts.join(".")}.-=${key}` : `-=${key}`]: null};
}
export function renameReferences(value, prefix = "", updates = {}) {
  if (typeof value === "string") {
    if (value.includes(OLD)) updates[prefix] = value.split(OLD).join(NEW);
  } else if (Array.isArray(value)) {
    // Arrays are compared and patched as a field, never via numeric dot paths.
    const migrated = value.map(v => replaceTree(v));
    if (!equal(value, migrated)) updates[prefix] = migrated;
  } else if (value && typeof value === "object") {
    if (prefix && Object.keys(value).some(k=>k.includes(".") || k.startsWith("-="))) {
      const migrated = replaceTree(value);
      if (!equal(value,migrated)) updates[prefix] = migrated;
      return updates;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes(".") || key.startsWith("-=")) continue;
      renameReferences(entry, prefix ? `${prefix}.${key}` : key, updates);
    }
  }
  return updates;
}
function replaceTree(v) {
  if (typeof v === "string") return v.split(OLD).join(NEW);
  if (Array.isArray(v)) return v.map(replaceTree);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,replaceTree(v)]));
  return v;
}
export function provenance(data, kind = "Item") {
  const refs = [data?._stats?.compendiumSource, data?.flags?.core?.sourceId].filter(v=>typeof v === "string" && v);
  const normalize = value => {
    value = value.replace(OLD, NEW);
    const legacy = /^Compendium\.dnd5e_classpack\.([\w-]+)\.([A-Za-z0-9]{16})$/.exec(value);
    return legacy ? `Compendium.dnd5e_classpack.${legacy[1]}.${kind}.${legacy[2]}` : value;
  };
  const sources = [...new Set(refs.map(normalize))];
  return {source: sources.length === 1 ? sources[0] : null, conflicting: sources.length > 1,
    hasSource: sources.length > 0, classpack: sources.some(s=>s.startsWith("Compendium.dnd5e_classpack."))};
}
export function evaluateTargets(item, entry) {
  const operations = [], reviews = [];
  if (item.toObject(true).type !== entry.itemType) return {operations:[],reviews:[{reason:"customized-item-type"}]};
  for (const target of entry.targets) {
    const document = target.kind === "ActiveEffect" ? item.effects?.get(target.id) : item;
    if (!document) {reviews.push({target: target.kind, id: target.id, reason: "missing-owned-effect"}); continue;}
    const data = document.toObject(true), updates = {}, before = {}, expected = [];
    if (target.kind === "ActiveEffect" && data.type !== target.type) {
      reviews.push({target:target.kind,id:target.id,reason:"customized-effect-type"}); continue;
    }
    for (const patch of target.patches) {
      const current = fieldState(data, patch.path);
      if (equal(current, patch.after)) continue;
      const knownStates = [patch.before,...(patch.beforeAlternatives ?? []).map(a=>a.state)];
      if (!knownStates.some(state=>equal(current,state))) {reviews.push({target: target.kind, id: target.id, path: patch.path, reason: "customized-or-unrecognized-field", current, expectedOld: patch.before}); continue;}
      Object.assign(updates, updateField(patch.path,patch.after));
      before[patch.path] = current;
      expected.push({path: patch.path, state: patch.after});
    }
    if (Object.keys(updates).length) operations.push({document, updates, before, expected});
  }
  // Keep dependent effect application/reference changes together during planning.
  return {operations: reviews.length ? [] : operations, reviews};
}
