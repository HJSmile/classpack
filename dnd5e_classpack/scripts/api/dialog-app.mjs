/**
 * An ApplicationV2 based form dialog used by the classpack API.
 *
 * The dialog is driven by a compact `inputs` descriptor:
 *
 *   [ "text", [ { label, name, options } ], { displayAsRows } ]
 *
 * `ClasspackDialogApp.dialog(title, content, inputs, buttons, options)`
 * resolves with the collected values, or `null` when the window is closed.
 */

import { log, localize, sleep } from "./utils.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TEMPLATE = "modules/dnd5e_classpack/templates/dialogApp.hbs";

class ClasspackDialogApp extends HandlebarsApplicationMixin(ApplicationV2) {
  #collected;
  #formContext;

  constructor(args = []) {
    const [title, content, inputs, buttons, options] = args;

    // ApplicationV2 freezes `this.options` and only keeps an explicit size while
    // it lives in `options.position`. Re-renders otherwise reset the window to
    // "auto" and it shrinks to fit. `position` therefore has to go through super.
    const position = {};
    if (Number.isFinite(options?.width)) position.width = options.width;
    if (Number.isFinite(options?.height)) position.height = options.height;
    else if (options?.compact) position.height = "auto";

    super({
      ...(options?.id ? { id: options.id } : {}),
      ...(options?.compact ? { classes: ["classpack-dialog-compact"] } : {}),
      position
    });

    this.dialogTitle = game.i18n.localize(title);
    this.content = content;
    this.inputs = inputs ?? [];
    this.buttons = buttons;
    this.compact = options?.compact === true;
  }

  static DEFAULT_OPTIONS = {
    tag: "form",
    form: {
      handler: ClasspackDialogApp.formHandler,
      submitOnChange: false,
      closeOnSubmit: false,
      id: "classpack-dialog-form"
    },
    actions: { confirm: ClasspackDialogApp.confirm },
    window: { title: "ClassPack", contentClasses: ["standard-form"] }
  };

  static PARTS = {
    form: { template: TEMPLATE, scrollable: [""] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static dialog(...args) {
    return new Promise(resolve => {
      const app = new ClasspackDialogApp(args);
      app.addEventListener("close", () => resolve(null), { once: true });
      app.submit = result => {
        resolve(result);
        app.close();
      };
      app.render({ force: true });
    });
  }

  static async formHandler(event, form, formData) {
    this.results = foundry.utils.expandObject(formData.object);
  }

  static async confirm(event, target) {
    await this.mergeResults(target.name);
  }

  async mergeResults(value) {
    if (value === "false") {
      this.submit({ buttons: false });
      return false;
    }
    while (this.results === undefined) await sleep(10);
    this.results.buttons = value === "true" || value;
    this.submit(this.results);
  }

  get title() {
    return this.dialogTitle;
  }

  get results() {
    return this.#collected;
  }

  set results(value) {
    this.#collected = value;
  }

  get context() {
    return this.#formContext;
  }

  set context(value) {
    this.#formContext = value;
  }

  /* -------------------------------------------------------------------- *
   *  Descriptor -> template context
   * -------------------------------------------------------------------- */

  static footerButton(label, name) {
    return { type: "submit", action: "confirm", label, name };
  }

  integerRange(min, max) {
    const values = [];
    for (let value = min; value <= max; value++) values.push(value);
    return values;
  }

  buildFooter() {
    switch (this.buttons) {
      case "yesNo":
        return [
          ClasspackDialogApp.footerButton(localize("Yes"), "true"),
          ClasspackDialogApp.footerButton(localize("No"), "false")
        ];
      case "okCancel":
        return [
          ClasspackDialogApp.footerButton(localize("OK", "OK"), "true"),
          ClasspackDialogApp.footerButton(localize("Cancel"), "false")
        ];
      case "ok":
        return [ClasspackDialogApp.footerButton(localize("OK", "OK"), "true")];
      case "cancel":
        return [ClasspackDialogApp.footerButton(localize("Cancel"), "false")];
      default:
        return [];
    }
  }

  /**
   * Turn one `[type, options, config]` descriptor into a group of slots.
   */
  buildGroup(type, options, config = {}) {
    const rows = config?.displayAsRows ?? false;
    const common = option => ({
      label: option.label,
      name: option.name,
      image: option.options?.image
    });

    switch (type) {
      case "button":
        return {
          kind: "buttons",
          rows,
          slots: options.map(option => ({
            ...common(option),
            value: option.options?.value,
            dice: option.options?.dice,
            diceClasses: option.options?.diceClasses,
            tooltip: option.options?.tooltip,
            reference: option.options?.reference
          }))
        };

      case "checkbox": {
        const slots = options.map(option => ({
          ...common(option),
          checked: option.options?.isChecked ?? false
        }));
        return {
          kind: "toggles",
          rows,
          limit: config?.totalMax ?? 99,
          picked: slots.filter(slot => slot.checked).length,
          slots
        };
      }

      case "radio":
        return {
          kind: "radios",
          rows,
          group: config?.radioName ?? "radio",
          slots: options.map(option => ({
            ...common(option),
            checked: option.options?.isChecked ?? false
          }))
        };

      case "selectAmount": {
        const slots = options.map(option => {
          const floor = option.options?.minAmount ?? 0;
          const max = option.options?.maxAmount ?? 10;
          return {
            ...common(option),
            weight: option.options?.weight ?? 1,
            floor,
            max,
            value: option.options?.currentAmount ?? 0,
            choices: this.integerRange(floor, max),
            ceiling: max
          };
        });
        return this.applyBudget({ kind: "amounts", rows, budget: config?.totalMax, slots });
      }

      case "selectMany":
        return {
          kind: "multiMenus",
          rows,
          slots: options.map(option => {
            const chosen = option.options?.value ?? [];
            return {
              ...common(option),
              value: chosen,
              entries: (option.options?.options ?? []).map(entry => ({
                label: entry.label,
                value: entry.value,
                selected: chosen.includes(entry.value)
              }))
            };
          })
        };

      case "selectOption":
        return {
          kind: "menus",
          rows,
          slots: options.map(option => {
            const raw = option.options?.options ?? ["none"];
            const entries = raw.length && typeof raw[0] === "object"
              ? raw.map(entry => ({ value: entry.value, label: entry.label }))
              : raw.map(value => ({ value, label: value }));
            return {
              ...common(option),
              value: option.options?.currentValue ?? "none",
              entries
            };
          })
        };

      case "text":
        return {
          kind: "texts",
          rows,
          slots: options.map(option => ({
            ...common(option),
            value: option.options?.currentValue ?? ""
          }))
        };

      case "number":
        return {
          kind: "numbers",
          rows,
          slots: options.map(option => ({
            ...common(option),
            value: option.options?.currentValue ?? 0
          }))
        };

      case "filePicker":
        return {
          kind: "paths",
          rows,
          slots: options.map(option => ({
            label: option.label,
            name: option.name,
            value: option.options?.currentValue ?? "",
            type: option.options?.type ?? "any"
          }))
        };

      default:
        log("warn", `Unknown dialog input type: ${type}`);
        return null;
    }
  }

  /**
   * Clamp an "amount" group against its optional point budget. Every slot keeps
   * the highest value it can still afford given the other slots' current picks.
   */
  applyBudget(group) {
    if (group.budget === undefined) {
      for (const slot of group.slots) slot.ceiling = slot.max;
      return group;
    }

    let spent = 0;
    for (const slot of group.slots) spent += slot.value * slot.weight;
    const remaining = group.budget - spent;

    for (const slot of group.slots) {
      const affordable = Math.floor((remaining + slot.value * slot.weight) / slot.weight);
      slot.ceiling = Math.max(slot.floor, Math.min(slot.max, affordable));
    }
    return group;
  }

  buildContext() {
    const groups = [];
    for (const [type, options, config] of this.inputs) {
      const group = this.buildGroup(type, options ?? [], config);
      if (group) groups.push(group);
    }
    return { content: this.content, groups, buttons: this.buildFooter(), compact: this.compact };
  }

  async _prepareContext() {
    if (!this.context) this.context = this.buildContext();
    return this.context;
  }

  /* -------------------------------------------------------------------- *
   *  Interaction
   * -------------------------------------------------------------------- */

  async _onChangeForm(formConfig, event) {
    const element = event.target;
    const groupIndex = Number(element.dataset?.cpGroup);
    const slotIndex = Number(element.dataset?.cpSlot);
    if (!Number.isInteger(groupIndex) || !Number.isInteger(slotIndex)) return;

    const group = this.context?.groups?.[groupIndex];
    const slot = group?.slots?.[slotIndex];
    if (!slot) return;

    const tag = element.localName;

    if (element.type === "checkbox") {
      slot.checked = element.checked;
      group.picked = group.slots.filter(entry => entry.checked).length;
    } else if (element.type === "radio") {
      for (const entry of group.slots) entry.checked = false;
      slot.checked = true;
    } else if (tag === "select") {
      if (group.kind === "amounts") {
        slot.value = Number(element.value);
        this.context.groups[groupIndex] = this.applyBudget(group);
      } else {
        slot.value = element.value;
      }
    } else if (tag === "multi-select") {
      slot.value = Array.from(element.value ?? []);
      for (const entry of slot.entries ?? []) entry.selected = slot.value.includes(entry.value);
    } else if (tag === "file-picker") {
      slot.value = element.value;
    } else if (element.type === "text" || element.type === "number") {
      slot.value = element.value;
    }

    this.render();
  }

  /**
   * Ping / highlight the referenced token when the user clicks or hovers an
   * option image. Options without a matching canvas token are ignored.
   */
  _onRender(context) {
    const nodes = this.element?.querySelectorAll("[data-cp-token]") ?? [];
    for (const node of nodes) {
      const tokenId = node.dataset.cpToken;
      if (!tokenId) continue;

      const find = () => canvas.tokens?.get(tokenId);
      const hover = state => {
        const token = find();
        if (!token) return;
        token.hover = state;
        token.refresh();
      };

      node.addEventListener("click", () => {
        const token = find();
        if (token) canvas.ping(token.center);
      });
      node.addEventListener("mouseenter", () => hover(true));
      node.addEventListener("mouseleave", () => hover(false));
    }
  }
}

export { ClasspackDialogApp };
