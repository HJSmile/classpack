/** Render stored intervention decisions after dnd5e/Midi have rendered and masked the card. */
export function createRollDisplayApi() {
  let installed = false;
  const modeLabel = mode => mode === 1 ? '优势' : mode === -1 ? '劣势' : '普通';
  function describe(roll) {
    const die = roll.d20 ?? roll.terms?.[0];
    if (die?.faces !== 20 || !Array.isArray(die.results)) return [];
    const finalSelectedIndex = die.results.findIndex(result => result.active && !result.rerolled);
    return Object.entries(roll.options?.classpackInterventions ?? {}).flatMap(([id, decision]) => {
      if (!['selected', 'cancelled'].includes(decision.state)) return [];
      const originalCount = decision.originalCount ?? die.results.length - (decision.additionalResults?.length ?? 0);
      const originalResults = decision.originalResults ?? die.results.slice(0, originalCount)
        .flatMap((result, index) => result.rerolled ? [] : [{ index, raw: result.result }]);
      const additionalResults = decision.additionalResults ?? die.results.slice(originalCount).map(result => result.result);
      const selectedIndex = decision.selectedIndex ?? finalSelectedIndex;
      const selected = die.results[selectedIndex];
      const selectedSource = selectedIndex >= originalCount ? `额外骰 ${selectedIndex - originalCount + 1}` : `原骰 ${selectedIndex + 1}`;
      const raw = decision.selectedResult ?? selected?.result;
      const counted = decision.selectedCounted ?? selected?.count ?? raw;
      return [{ id, ...decision, originalCount, originalResults, additionalResults, selectedIndex,
        mode: modeLabel(decision.originalAdvantageMode ?? roll.options.advantageMode),
        selectedText: raw !== undefined ? `${raw}${counted !== raw ? `（按 ${counted} 计）` : ''}（${selectedSource}）` : '' }];
    });
  }
  function canReveal(message, roll, diceNode) {
    if (message.isContentVisible === false || !diceNode || diceNode.hidden || diceNode.style.display === 'none') return false;
    const total = diceNode.querySelector('.dice-total, .total, .d20die .roll');
    if (!total || !/\d/.test(total.textContent ?? '')) return false;
    if (game.user?.isGM) return true;
    const flags = message.flags?.['midi-qol'];
    if (message.blind || flags?.forcedBlind || flags?.obscureRoll) return false;
    const attack = roll.options?.['midi-qol']?.rollType === 'attack';
    if (attack && flags?.GMOnlyAttackRoll) return false;
    // Midi removes the tooltip when dice details are hidden, even if it keeps the attack total.
    if (attack && message.author?.isGM && !diceNode.querySelector('.dice-tooltip')) return false;
    return true;
  }
  function decorate(message, roll, diceNode) {
    const decisions = describe(roll);
    if (!decisions.length || !canReveal(message, roll, diceNode) || diceNode.dataset.classpackInterventions) return false;
    const doc = diceNode.ownerDocument;
    const breakdown = diceNode.matches('button') && diceNode.nextElementSibling?.matches('.roll-breakdown')
      ? diceNode.nextElementSibling : null;
    const note = doc.createElement('div');
    note.className = 'classpack-roll-interventions';
    note.style.whiteSpace = 'normal';
    for (const decision of decisions) {
      const entry = doc.createElement('div'), heading = doc.createElement('strong'), detail = doc.createElement('span');
      entry.className = 'classpack-roll-intervention';
      const strategy = decision.strategy === 'highest' ? '（取高）' : decision.strategy === 'lowest' ? '（取低）' : '';
      heading.textContent = `${decision.label ?? decision.id}${strategy}：`;
      detail.textContent = decision.state === 'cancelled'
        ? '互相抵消，无额外骰。'
        : `原骰 ${decision.originalResults.map(result => result.raw).join(' / ')} · `
          + `${decision.additionalResults.length ? `额外 ${decision.additionalResults.join(' / ')} · ` : ''}`
          + `选用 ${decision.selectedText}`;
      entry.append(heading, detail); note.append(entry);
    }
    if (diceNode.matches('button')) {
      (diceNode.closest('.icon-row') ?? breakdown ?? diceNode).insertAdjacentElement('afterend', note);
    } else diceNode.prepend(note);
    diceNode.dataset.classpackInterventions = 'true';
    const selected = decisions.findLast(decision => decision.state === 'selected');
    if (selected) {
      const originalD20 = decisions[0].originalD20Formula
        ?? decisions[0].originalFormula?.match(/^\s*(?:\d+)?d20(?:[A-Za-z0-9=<>]+)?(?:\[[^\]]*\])?/i)?.[0];
      const formula = originalD20 && roll.terms.map((term, index) => index === 0 ? originalD20
        : term.formula ?? term.operator ?? String(term.number ?? '')).join(' ');
      for (const node of [diceNode, breakdown].filter(Boolean).flatMap(root => [...root.querySelectorAll('.dice-formula')])) {
        if (formula) node.textContent = formula;
      }
      const dice = diceNode.querySelector('.dice-tooltip .dice-rolls') ?? breakdown?.querySelector('.dice-tooltip .dice-rolls');
      if (dice) [...dice.children].forEach((node, index) => {
        const extra = index >= selected.originalCount;
        const label = `${extra ? '额外骰' : '原骰'} ${extra ? index - selected.originalCount + 1 : index + 1}`;
        node.dataset.classpackDie = extra ? 'additional' : 'original';
        node.title = `${node.title ? `${node.title}；` : ''}${label}${index === selected.selectedIndex ? '（选用）' : ''}`;
        node.setAttribute('aria-label', `${label}：${node.textContent}${index === selected.selectedIndex ? '，选用' : ''}`);
      });
    }
    const section = diceNode.closest('.midi-qol-attack-roll'), label = section?.querySelector('.midi-roll-label');
    if (label) {
      for (const node of [...label.childNodes]) if (node.nodeType === 3) node.remove();
      const attack = decisions[0].originalAdvantageMode ? decisions[0].mode : game.i18n?.localize('DND5E.Attack') ?? '攻击';
      label.prepend(doc.createTextNode(`${attack} · ${decisions.map(d => d.label ?? d.id).join('、')}`));
    }
    return true;
  }
  function renderMessage(message, root) {
    if (!root?.querySelectorAll || root.hidden || root.style.display === 'none') return;
    const nativeDice = [...root.querySelectorAll('.dice-roll')].filter(node => {
      const summary = node.closest('.card-summary');
      return !summary || summary === root;
    });
    const typeIndices = new Map();
    for (const [index, roll] of Array.from(message.rolls ?? []).entries()) {
      const type = roll.options?.['midi-qol']?.rollType;
      const typeIndex = typeIndices.get(type) ?? 0;
      typeIndices.set(type, typeIndex + 1);
      let diceNode;
      if (type === 'attack' || type === 'utility') {
        const section = root.querySelector(type === 'attack' ? '.midi-qol-attack-roll' : '.midi-qol-utility-roll');
        diceNode = section?.querySelectorAll('.dice-roll')[typeIndex];
      } else if (type === 'save' && roll.options['midi-qol'].targetUuid) {
        const uuid = roll.options['midi-qol'].targetUuid;
        const row = [...root.querySelectorAll('.midi-qol-save-name[data-uuid]')].find(node => node.dataset.uuid === uuid)?.closest('li');
        diceNode = row?.querySelector('.midi-qol-save-tooltip .dice-roll');
      }
      // Native attack/check/save cards can still carry Midi's roll tags.
      if (!diceNode && !message.system?.midi) diceNode = nativeDice[index];
      decorate(message, roll, diceNode);
    }
    // Summaries are rendered from their own messages, whose visibility can differ from the parent card.
    for (const summary of root.querySelectorAll('.card-summary[data-message-id]')) {
      const source = game.messages?.get(summary.dataset.messageId);
      if (source) renderMessage(source, summary);
    }
  }
  function install() {
    if (installed) return false;
    Hooks.on('dnd5e.renderChatMessage', renderMessage);
    installed = true; return true;
  }
  return Object.freeze({ describe, canReveal, decorate, renderMessage, install, get installed() { return installed; } });
}
