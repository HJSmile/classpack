import { MODULE_ID } from './utils.mjs';

/** Identity registry shared by feature/spell automations, independent of CPR installation. */
export function createAutomationRegistry() {
  const definitions = new Map();
  const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  function register(definition) {
    if (!definition?.id || definitions.has(definition.id)) throw new Error('Automation id must be unique.');
    definitions.set(definition.id, Object.freeze({ ...definition }));
    return () => definitions.delete(definition.id);
  }
  function match(item, id) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Unknown automation: ${id}`);
    if (!item || (definition.itemTypes && !definition.itemTypes.includes(item.type)) || item.system?.isHidden) {
      return { matched: false, reason: 'item-type' };
    }
    const flags = item.flags?.[MODULE_ID];
    const binding = flags?.automations?.[id] ?? (definition.legacyBinding ? flags?.[definition.legacyBinding] : null);
    if (binding?.enabled === false) return { matched: false, reason: 'disabled' };
    const rules = String(item.system?.source?.rules ?? item.flags?.cat?.automation?.rules ?? '');
    if (definition.rules && rules && rules !== definition.rules) return { matched: false, reason: 'rules' };
    if (binding?.enabled === true || definition.legacyEnabled?.(item)) return { matched: true, reason: 'explicit', id, rules };
    const kind = item.system?.type?.value;
    if (definition.itemKinds && kind && !definition.itemKinds.includes(kind)) return { matched: false, reason: 'item-kind' };
    const identifiers = [item.system?.identifier, item.flags?.cat?.identifier,
      item.flags?.['chris-premades']?.info?.identifier, item.flags?.['chris-premades']?.identifier].filter(Boolean);
    if (identifiers.some(identifier => definition.explicitIdentifiers?.includes(identifier))) {
      return { matched: true, reason: 'explicit-identifier', id, rules };
    }
    if ((!definition.rules || rules === definition.rules) && identifiers.some(identifier => definition.identifiers?.includes(identifier))) {
      return { matched: true, reason: 'identifier-and-rules', id, rules };
    }
    const source = item._stats?.compendiumSource ?? item.flags?.core?.sourceId;
    if (source && definition.sourceUuids?.includes(source)) return { matched: true, reason: 'source', id, rules };
    if ((!definition.rules || rules === definition.rules) && definition.names?.some(name => normalize(name) === normalize(item.name))) {
      return { matched: true, reason: 'exact-name', id, rules };
    }
    return { matched: false, reason: 'unmatched' };
  }
  function find(actor, id) { return actor?.items?.find(item => match(item, id).matched); }
  async function configure(item, id, { enabled = true } = {}) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Unknown automation: ${id}`);
    if (!game.user.isGM && !item.testUserPermission(game.user, 'OWNER')) throw new Error('No permission to configure item.');
    if (definition.itemTypes && !definition.itemTypes.includes(item.type)) throw new Error('Unsupported item type.');
    const rules = item.system?.source?.rules;
    if (enabled && rules && definition.rules && rules !== definition.rules) throw new Error(`Cannot bind ${id} to rules ${rules}; expected ${definition.rules}.`);
    const updates = { [`flags.${MODULE_ID}.automations.${id}`]: { enabled, version: definition.version ?? '1.0.0' } };
    if (enabled && !item.system.identifier && definition.identifiers?.[0]) updates['system.identifier'] = definition.identifiers[0];
    if (enabled && !item.system.uses?.max && definition.uses) {
      updates['system.uses.max'] = definition.uses.max;
      updates['system.uses.recovery'] = definition.uses.recovery;
    }
    return item.update(updates);
  }
  return Object.freeze({ register, match, find, configure, get: id => definitions.get(id) });
}
