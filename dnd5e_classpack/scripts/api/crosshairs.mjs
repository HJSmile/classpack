import { pointDistance, positionAtCenter, tokenCenter } from "./geometry.mjs";
import { resolveOriginPoint } from "./utils.mjs";

const active = new Map();
const TARGET_ICON = "icons/svg/dice-target.svg";
const HAZARD_ICON = "icons/svg/hazard.svg";

/** Public facade; Foundry owns the transient Region and its event listeners. */
class ClasspackCrosshairs {
  static ERROR_TEXTURE = HAZARD_ICON;
  constructor(config = {}, callbacks = {}) {
    this.config = { ...ClasspackCrosshairs.defaultCrosshairsConfig(), ...config };
    Object.assign(this, this.config);
    this.hooks = callbacks;
    this.elevation ??= canvas.level?.elevation ?? 0;
    this.scene = canvas.scene;
    this.radius = this.size * this.scene.grid.size / this.scene.grid.distance / 2;
    this.valid = false;
    this.cancelled = true;
    this.inFlight = false;
  }
  static defaultCrosshairsConfig() {
    return { size: globalThis.canvas?.scene?.grid.distance ?? 5, icon: TARGET_ICON,
      label: "", tag: "crosshairs", direction: 0, drawIcon: true, drawOutline: true,
      fillAlpha: 0, lockSize: true, lockPosition: false, resolution: 2, rememberControlled: false };
  }
  static show(config = {}, callbacks = {}) { return this.showCrosshairs(config, callbacks); }
  static async showCrosshairs(config = {}, callbacks = {}) {
    if (!globalThis.canvas?.ready || typeof canvas.regions?.placeRegion !== "function" || config.signal?.aborted) {
      return { x: config.x ?? 0, y: config.y ?? 0, direction: config.direction ?? 0,
        elevation: config.elevation ?? 0, valid: false, cancelled: true };
    }
    return new this(config, callbacks).drawPreview();
  }
  static getCrosshair(tag) { return active.get(tag); }
  static getSnappedPosition(point, resolution = 2) {
    if (!resolution || canvas.grid.isGridless) return { x: point.x, y: point.y };
    const mode = resolution < 0 ? CONST.GRID_SNAPPING_MODES.VERTEX : CONST.GRID_SNAPPING_MODES.CENTER;
    return canvas.grid.getSnappedPoint(point, { mode, resolution: Math.abs(resolution) });
  }
  static _containsCenter(placeable, crosshair) {
    const center = placeable.document?.documentName === "Token" ? tokenCenter(placeable) : placeable.center;
    return center && Math.hypot(center.x - crosshair.x, center.y - crosshair.y) <= crosshair.radius;
  }
  static collectPlaceables(crosshair, type = "Token", contains = this._containsCenter) {
    const types = Array.isArray(type) ? type : [type], result = {};
    for (const name of types) result[name] = Array.from((crosshair.scene ?? canvas.scene).getEmbeddedCollection(name))
      .filter(doc => doc.object && contains(doc.object, crosshair));
    return Array.isArray(type) ? result : result[types[0]];
  }
  toObject() {
    return { x: this.x ?? 0, y: this.y ?? 0, direction: this.direction,
      elevation: this.elevation, valid: this.valid && !this.cancelled, cancelled: this.cancelled };
  }
  refresh() {
    if (this.preview && !this.preview.destroyed) {
      this.preview.document.color = this.valid ? (this.config.fillColor ?? game.user.color) : "#ff3333";
      this.preview.renderFlags.set({ refresh: true });
    }
    return this;
  }
  async draw() { return this.refresh(); }
  _callback(name) {
    try {
      const result = this.hooks[name]?.(this);
      if (name === "confirm" && result?.then) {
        result.catch(error => console.error("ClassPack crosshairs confirm", error));
        this.cancel();
        return false;
      }
      if (result?.then) result.catch(error => { console.error(`ClassPack crosshairs ${name}`, error); this.cancel(); });
      return result;
    } catch (error) {
      console.error(`ClassPack crosshairs ${name}`, error);
      this.cancel();
      return false;
    }
  }
  cancel() {
    // Core has no public cancel method. Only cancel the context owned by this facade.
    if (this.preview && this.layer?._placementContext?.preview === this.preview) this.layer._cancelPlacement();
  }
  _validate() {
    try {
      this.valid = (this.config.validityFunctions ?? []).every(test => {
        const value = test(this);
        if (value?.then) {
          value.catch(error => console.error("ClassPack placement validator", error));
          throw new TypeError("ClassPack placement validators must be synchronous.");
        }
        return value !== false;
      });
    } catch (error) {
      this.valid = false;
      console.error("ClassPack placement validation failed", error);
      this.cancel();
    }
    this.refresh();
    return this.valid;
  }
  async drawPreview() {
    const layer = this.layer = canvas.regions, scene = this.scene;
    const levelId = canvas.level?.id;
    const sameView = () => canvas.scene === scene && canvas.level?.id === levelId;
    const remembered = this.rememberControlled ? [...canvas.tokens.controlled] : [];
    active.get(this.tag)?.cancel();
    active.set(this.tag, this);
    this.inFlight = true;
    let timer, shown = false;
    const signal = this.config.signal, abort = () => this.cancel();
    const initialize = ({ document, preview }) => {
      this.document = document;
      if (preview) this.preview = preview;
      if (!shown) {
        shown = true;
        this._callback("show");
      }
    };
    try {
      this.x ??= canvas.mousePosition.x; this.y ??= canvas.mousePosition.y;
      const shape = { type: "circle", x: this.x, y: this.y, radius: Math.max(1, this.radius) };
      const promise = layer.placeRegion({ name: this.label || "ClassPack", shapes: [shape],
        color: this.config.fillColor ?? game.user.color, levels: canvas.level ? [canvas.level.id] : [],
        visibility: CONST.REGION_VISIBILITY.ALWAYS, displayMeasurements: true }, {
        create: false, allowRotation: true,
        onMove: context => {
          initialize(context);
          const point = this.lockPosition ? { x: this.x, y: this.y }
            : this.config.snapPoint ? this.config.snapPoint(context.position)
              : ClasspackCrosshairs.getSnappedPosition(context.position, this.resolution);
          this.x = point.x; this.y = point.y;
          context.shape.move(point, { snap: false });
          return false;
        },
        onRotate: context => {
          initialize(context);
          this.direction = (this.direction + (context.precise ? 5 : 15) * Math.sign(context.event.delta) + 360) % 360;
          this._validate(); this._callback("rotate");
          return false;
        },
        onChange: context => {
          initialize(context);
          this.x = context.shape.x; this.y = context.shape.y;
          this._validate(); this._callback("move");
        },
        preConfirm: context => {
          initialize(context);
          if (!sameView()) { this.cancel(); return false; }
          if (!this._validate()) {
            ui.notifications.warn("ClassPack：落点无效，请重新选择，或右键取消。");
            return false;
          }
          return this._callback("confirm") !== false;
        },
        preCommit: () => sameView() && !signal?.aborted && this._validate()
      });
      this.preview ??= layer._placementContext?.preview;
      if (Number.isFinite(this.config.timeout) && this.config.timeout > 0) timer = setTimeout(abort, this.config.timeout);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const document = await promise;
      if (document?.shapes.length && sameView() && !signal?.aborted) {
        this.x = document.shapes[0].x; this.y = document.shapes[0].y;
        this.cancelled = !this._validate();
      }
    } catch (error) {
      this.cancel();
      console.error("ClassPack Region placement failed", error);
      ui.notifications.warn("ClassPack：放置失败，已取消操作。");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.inFlight = false;
      if (active.get(this.tag) === this) active.delete(this.tag);
      if (sameView()) for (const token of remembered) {
        if (!token.destroyed && token.document.parent === scene) token.control({ releaseOthers: false });
      }
    }
    return this.toObject();
  }
}

/** Validate range and elevation on the scene grid at confirmation and commit. */
async function aimCrosshair({ token, maxRange, crosshairsConfig = {}, centerpoint, customCallbacks = {},
  validityFunctions = [], checkCollision = false, drawBoundries = true } = {}) {
  if (!globalThis.canvas?.ready || !canvas.regions?.placeRegion) return ClasspackCrosshairs.showCrosshairs(crosshairsConfig);
  const scene = canvas.scene;
  const origin = centerpoint ? await resolveOriginPoint(centerpoint) : tokenCenter(token);
  if (!origin) return { x: 0, y: 0, direction: 0, elevation: 0, valid: false, cancelled: true };
  const tests = [crosshair => !Number.isFinite(Number(maxRange))
    || pointDistance(scene, origin, crosshair) <= Number(maxRange) + 1e-6,
    crosshair => !checkCollision || !token?.checkCollision(crosshair, { origin, type: "move", mode: "any" }),
    ...validityFunctions];
  const config = { x: origin.x, y: origin.y, elevation: origin.elevation ?? 0, ...crosshairsConfig,
    validityFunctions: [...tests, ...(crosshairsConfig.validityFunctions ?? [])] };
  if (token && !config.snapPoint) config.snapPoint = point => tokenCenter(token, positionAtCenter(token, { ...point, elevation: config.elevation }));
  let boundary;
  try {
    if (drawBoundries && Number.isFinite(Number(maxRange)) && Number(maxRange) > 0
      && globalThis.PIXI?.Graphics && canvas.stage?.addChild) {
      boundary = new PIXI.Graphics();
      boundary.eventMode = "none";
      boundary.lineStyle(2, 0x66ccff, 0.9).beginFill(0x66ccff, 0.06)
        .drawPolygon(scene.grid.getCircle(origin, Number(maxRange))).endFill();
      canvas.stage.addChild(boundary);
    }
    return await ClasspackCrosshairs.showCrosshairs(config, customCallbacks);
  } finally {
    if (boundary && !boundary.destroyed) {
      boundary.parent?.removeChild(boundary);
      boundary.destroy({ children: true });
    }
  }
}

export { ClasspackCrosshairs, aimCrosshair };
