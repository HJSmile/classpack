/**
 * Dialog helpers used by the classpack macros. Every helper accepts a `userId`
 * option and routes through the open-dialog function supplied by the entry
 * point, so socketlib routing is applied automatically.
 */

function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]*>?|@UUID\[.*?\]{(.*?)}/gm, "$1");
}

function localize(key, fallback = key) {
  const value = game.i18n.localize(key);
  return value === key ? fallback : value;
}

/**
 * @param openDialog - function (...args) => Promise<object|null>
 *                     Same signature as ClasspackDialogApp.dialog / api.dialog.
 */
export function createDialogUtils(openDialog) {
  const dialog = (...args) => openDialog(...args);

  /**
   * A grid/list of labelled submit buttons.
   * `buttons` is an array of `[label, name, options?]` tuples.
   */
  async function buttonDialog(title, content, buttons, { displayAsRows = true, userId = game.user.id, width = 400, compact = false } = {}) {
    const inputs = [["button", buttons.map(([label, name, options]) => ({
      label,
      name,
      options: options ?? {}
    })), { displayAsRows }]];
    const result = await dialog(title, content, inputs, undefined, { userId, width, compact });
    return result?.buttons ?? false;
  }

  /**
   * A single number input.
   */
  async function numberDialog(title, content, { label = "Label", name = "identifier", options = {} } = {}, { buttons = "okCancel", userId = game.user.id } = {}) {
    const result = await dialog(title, content, [["number", [{ label, name, options }]]], buttons, { userId });
    return result?.[name];
  }

  /**
   * A single select dropdown.
   */
  async function selectDialog(title, content, { label = "Label", name = "identifier", options = {} } = {}, { buttons = "okCancel", userId = game.user.id } = {}) {
    const rawOptions = options.options ?? [];
    let selectOptions = rawOptions;
    if (!selectOptions.length) {
      selectOptions = ["None"];
    } else if (selectOptions[0]?.label === undefined) {
      selectOptions = selectOptions.map(value => ({ value, label: value }));
    }
    const result = await dialog(
      title,
      content,
      [["selectOption", [{ label, name, options: { ...options, options: selectOptions } }]]],
      buttons,
      { userId }
    );
    return result?.[name];
  }

  /**
   * Yes/No (or Ok/Cancel) confirmation. Returns boolean.
   */
  async function confirm(title, content, { userId = game.user.id, buttons = "yesNo" } = {}) {
    const result = await dialog(title, content, [], buttons, { userId });
    return result?.buttons ?? false;
  }

  /**
   * Confirm using an Item's name and a standard use prompt.
   */
  async function confirmUseItem(item, { userId = game.user.id, buttons = "yesNo" } = {}) {
    const content = game.i18n.format("DND5E.Use", { itemName: item.name });
    return await confirm(item.name, content, { userId, buttons });
  }

  /**
   * Select a single document from a list of buttons.
   */
  async function selectDocumentDialog(title, content, documents, {
    displayTooltips = false,
    sortAlphabetical = false,
    sortCR = false,
    userId = game.user.id,
    addNoneDocument = false,
    showCR = false,
    showSpellLevel = false,
    showUses = false,
    width = 400
  } = {}) {
    let docs = [...documents];
    if (sortAlphabetical) {
      docs = docs.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang ?? "en", { sensitivity: "base" }));
    }
    if (sortCR) {
      docs = docs.sort((a, b) => (b.system?.details?.cr ?? -1) > (a.system?.details?.cr ?? -1) ? -1 : 1);
    }

    const describe = doc => {
      let label = doc.name;
      if (showCR) label += ` [${game.i18n.format("DND5E.CRLabel", { cr: doc.system?.details?.cr ?? "?" })}]`;
      if (showSpellLevel) label += ` [${localize("DND5E.SpellLevel")} ${doc.system?.level ?? "?"}]`;
      const uses = doc.system?.uses ?? doc.uses;
      if (showUses && uses?.max) label += ` [${uses.value ?? "?"}/${uses.max} ${localize("DND5E.Uses")}]`;
      if (doc.system?.linkedActivity) label += ` (${doc.system.linkedActivity.item.name})`;
      return label;
    };

    const buttons = docs.map(doc => ({
      label: describe(doc),
      name: doc.id ?? doc.uuid,
      options: {
        image: doc.img,
        tooltip: displayTooltips ? stripHtml(doc.system?.description?.value) : undefined
      }
    }));

    if (addNoneDocument) {
      buttons.push({
        label: localize("DND5E.None", "None"),
        name: "none",
        options: { image: "icons/svg/cancel.svg" }
      });
    }

    const result = await dialog(title, content, [["button", buttons, { displayAsRows: true }]], undefined, { userId, width });
    if (!result?.buttons) return undefined;

    if (result.buttons === "none") return undefined;
    return docs.find(doc => (doc.id ?? doc.uuid) === result.buttons) ?? (await fromUuid(result.buttons));
  }

  /**
   * Select several documents, either as checkboxes or select-amount inputs.
   */
  async function selectDocumentsDialog(title, content, documents, {
    max = 1,
    displayTooltips = false,
    sortAlphabetical = false,
    sortCR = false,
    userId = game.user.id,
    showCR = false,
    showSpellLevel = false,
    showUses = false,
    checkbox = false,
    weights = {},
    maxes = {}
  } = {}) {
    let docs = [...documents];
    if (sortAlphabetical) {
      docs = docs.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang ?? "en", { sensitivity: "base" }));
    }
    if (sortCR) {
      docs = docs.sort((a, b) => (b.system?.details?.cr ?? -1) > (a.system?.details?.cr ?? -1) ? -1 : 1);
    }

    const describe = doc => {
      let label = doc.name;
      if (showCR) label += ` [${game.i18n.format("DND5E.CRLabel", { cr: doc.system?.details?.cr ?? "?" })}]`;
      if (showSpellLevel) label += ` [${localize("DND5E.SpellLevel")} ${doc.system?.level ?? "?"}]`;
      const uses = doc.system?.uses ?? doc.uses;
      if (showUses && uses?.max) label += ` [${uses.value ?? "?"}/${uses.max} ${localize("DND5E.Uses")}]`;
      if (doc.system?.linkedActivity) label += ` (${doc.system.linkedActivity.item.name})`;
      return label;
    };

    const options = docs.map(doc => ({
      label: describe(doc),
      name: doc.id ?? doc.uuid,
      options: {
        image: doc.img,
        tooltip: displayTooltips ? stripHtml(doc.system?.description?.value) : undefined,
        minAmount: 0,
        maxAmount: maxes[doc.id] ?? max,
        weight: weights[doc.id] ?? 1
      }
    }));

    const inputType = checkbox ? "checkbox" : "selectAmount";
    const result = await dialog(title, content, [[inputType, options, { displayAsRows: true, totalMax: max }]], "okCancel", { userId, height: "auto" });

    if (!result?.buttons) return undefined;

    const selected = [];
    for (const [key, value] of Object.entries(result)) {
      if (key === "buttons" || !value) continue;
      const doc = docs.find(entry => (entry.id ?? entry.uuid) === key);
      if (!doc) continue;
      selected.push({ document: doc, amount: Number(value) });
    }
    return selected;
  }

  /**
   * Select one or more tokens from an array of Token placeables / documents.
   */
  async function selectTargetDialog(title, content, targets, {
    type = "one",
    selectOptions = [],
    skipDeadAndUnconscious = true,
    maxAmount = 1,
    minAmount = 0,
    userId = game.user.id,
    buttons = "okCancel",
    maxes = {},
    width = 500
  } = {}) {
    const inputType = type === "multiple" ? "checkbox"
      : type === "number" ? "number"
      : type === "select" ? "selectOption"
      : type === "selectAmount" ? "selectAmount"
      : "radio";

    const normalizedSelectOptions = selectOptions.length && selectOptions[0]?.label === undefined
      ? selectOptions.map(value => ({ value, label: value }))
      : selectOptions;

    const options = [];
    for (const tokenish of targets) {
      const token = tokenish?.document ?? tokenish;
      const doc = token?.document ?? token;
      const label = doc.name ?? token.name ?? "?";
      const image = doc.texture?.src ?? doc.img ?? token.texture?.src ?? undefined;
      const isFirst = options.length === 0;
      options.push({
        label,
        name: token.id ?? doc.id ?? doc.uuid,
        options: {
          image,
          isChecked: isFirst,
          options: normalizedSelectOptions,
          maxAmount: maxes[token.id ?? doc.id] ?? maxAmount,
          minAmount
        }
      });
    }

    const inputs = [[inputType, options, { displayAsRows: true, radioName: "targets", totalMax: maxAmount }]];
    if (skipDeadAndUnconscious) {
      inputs.push(["checkbox", [{ label: localize("DND5E.SkipDeadAndUnconscious", "Skip dead & unconscious"), name: "skip", options: { isChecked: true } }]]);
    }

    const result = await dialog(title, content, inputs, buttons, { userId, width });
    if (!result || result.buttons === false) return [undefined, result?.skip];

    const skip = result?.skip;
    switch (type) {
      case "multiple": {
        const selected = [];
        for (const [key, value] of Object.entries(result)) {
          if (key === "buttons" || key === "skip" || !value) continue;
          const token = targets.find(entry => (entry.id ?? entry.document?.id ?? entry.document?.uuid) === key);
          if (token) selected.push(token);
        }
        return [selected, skip];
      }
      case "number":
      case "select":
      case "selectAmount": {
        const selected = [];
        for (const [key, value] of Object.entries(result)) {
          if (key === "buttons" || key === "skip" || !value || value === "0") continue;
          const token = targets.find(entry => (entry.id ?? entry.document?.id ?? entry.document?.uuid) === key);
          if (token) selected.push({ document: token, value });
        }
        return [selected, skip];
      }
      case "one":
      default:
        return [targets.find(entry => (entry.id ?? entry.document?.id ?? entry.document?.uuid) === result.targets), skip];
    }
  }

  /**
   * Select a damage type from the dnd5e damage type configuration.
   */
  async function selectDamageType(damageTypes, title, content, { addNo = false, userId = game.user.id } = {}) {
    const buttons = damageTypes.map(type => {
      const config = CONFIG.DND5E.damageTypes?.[type];
      return [
        config?.label ?? type,
        type,
        { image: config?.icon ?? "icons/magic/symbols/question-stone-yellow.webp" }
      ];
    });
    if (addNo) buttons.push([localize("DND5E.None", "None"), false, { image: "icons/svg/cancel.svg" }]);
    return await buttonDialog(title, content, buttons, { userId });
  }

  /**
   * Select a spell slot for an actor.
   */
  async function selectSpellSlot(actor, title, content, { maxLevel = 9, minLevel = 0, userId = game.user.id, no = false } = {}) {
    const slots = Object.entries(actor.system?.spells ?? {})
      .filter(([key, value]) => {
        if (value.level > maxLevel || value.level < minLevel || key === "spell0") return false;
        return value.value > 0 && value.max > 0;
      })
      .map(([key, value]) => {
        if (key === "pact") {
          return [CONFIG.DND5E.spellPreparationModes?.pact?.label ?? "Pact", "pact"];
        }
        return [CONFIG.DND5E.spellLevels?.[value.level] ?? value.level, value.level];
      });

    if (no) slots.push([localize("DND5E.None", "None"), false]);
    return await buttonDialog(title, content, slots, { displayAsRows: true, userId });
  }

  /**
   * Select hit dice from an actor's classes.
   */
  async function selectHitDie(actor, title, content, { max = 1, userId = game.user.id } = {}) {
    const classes = actor.items
      .filter(item => item.type === "class" && item.system.levels - (item.system.hd?.spent ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang ?? "en", { sensitivity: "base" }));

    if (!classes.length) return undefined;

    const options = classes.map(item => {
      const remaining = item.system.levels - (item.system.hd?.spent ?? 0);
      return {
        label: `${item.name} [${remaining}/${item.system.levels} d${item.system.hd?.denomination ?? "?"}]`,
        name: item.id,
        options: {
          image: item.img,
          minAmount: 0,
          maxAmount: Math.min(remaining, max)
        }
      };
    });

    const inputType = max === 1 ? "checkbox" : "selectAmount";
    const result = await dialog(title, content, [[inputType, options, { displayAsRows: true, totalMax: max }]], "okCancel", { userId, height: "auto" });
    if (!result?.buttons) return undefined;

    const selected = [];
    for (const [key, value] of Object.entries(result)) {
      if (key === "buttons" || !value) continue;
      const item = classes.find(entry => entry.id === key);
      if (item) selected.push({ document: item, amount: Number(value) });
    }
    return selected;
  }

  /**
   * Select individual dice results from evaluated rolls.
   */
  async function selectDie(rolls = [], title, content, { max = 1, userId = game.user.id, buttons = "okCancel" } = {}) {
    const options = [];
    for (let i = 0; i < rolls.length; i++) {
      const roll = rolls[i];
      for (let a = 0; a < roll.terms.length; a++) {
        const term = roll.terms[a];
        if (term.isDeterministic) continue;
        for (let r = 0; r < term.results.length; r++) {
          options.push({
            name: `${i}-${a}-${r}`,
            label: `${term.results[r].result} (d${term.faces})`
          });
        }
      }
    }

    const result = await dialog(title, content, [["checkbox", options, { displayAsRows: true, totalMax: max }]], buttons, { userId, height: "auto" });
    if (!result?.buttons) return undefined;
    return Object.entries(result)
      .filter(([key, value]) => key !== "buttons" && value)
      .map(([key]) => key);
  }

  return {
    buttonDialog,
    numberDialog,
    selectDialog,
    selectDocumentDialog,
    selectDocumentsDialog,
    selectTargetDialog,
    selectDamageType,
    selectSpellSlot,
    selectHitDie,
    selectDie,
    confirm,
    confirmUseItem
  };
}
