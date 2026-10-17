import { resolveOriginPoint } from "./utils.mjs";
import { aimCrosshair } from "./crosshairs.mjs";
import { occupied, pointDistance, positionAtCenter, tokenCenter, tokenDocument } from "./geometry.mjs";
import { moveTokens } from "./movement.mjs";

const DEFAULTS = { animation: "none", isSynchronous: true, crosshairsConfig: {}, callbacks: {},
  range: 100, updates: {}, minimizeSheet: true, centerpoint: null, isGroup: false,
  validityFunctions: [], preserveOffsets: true, avoidOccupied: false, animate: false };

class ClasspackTeleport {
  constructor(tokens, reference, options = {}) {
    this.tokens = Array.isArray(tokens) ? tokens : [tokens];
    this.reference = reference ?? this.tokens[0];
    this.options = { ...DEFAULTS, ...options };
    this.scene = tokenDocument(this.tokens[0]).parent;
    if (this.tokens.some(token => tokenDocument(token).parent !== this.scene)
      || tokenDocument(this.reference).parent !== this.scene) throw new Error("ClassPack teleport requires one scene.");
    this.commit = options.commit ?? (updates => moveTokens(this.scene.id, updates,
      { teleport: true, animate: this.options.animate, animation: this.options.movementAnimation }));
  }
  static group(tokens, reference, options = {}) {
    return new this(tokens, reference, { ...options, isGroup: true }).go();
  }
  static target(token, reference, options = {}) { return new this(token, reference, options).go(); }
  static point(tokens, options = {}) {
    const list = Array.isArray(tokens) ? tokens : [tokens];
    if (!list.length) return;
    return new this(list, list[0], { ...options, isGroup: list.length > 1 }).go();
  }
  positions(point) {
    const reference = tokenCenter(this.reference);
    return this.tokens.map(token => {
      const center = tokenCenter(token);
      const preserve = this.options.isGroup && this.options.preserveOffsets;
      const landing = { x: point.x + (preserve ? center.x - reference.x : 0),
        y: point.y + (preserve ? center.y - reference.y : 0),
        elevation: point.elevation + (preserve ? center.elevation - reference.elevation : 0) };
      return { ...this.options.updates, ...positionAtCenter(token, landing, { dimensions: this.options.updates }),
        rotation: point.direction, _id: tokenDocument(token).id };
    });
  }
  validPositions(point, origin) {
    if (canvas.scene !== this.scene) return false;
    const ignore = new Set(this.tokens.map(token => tokenDocument(token).id));
    const updates = this.positions(point);
    return updates.every((position, i) => {
      const center = tokenCenter(this.tokens[i], position);
      if (Number.isFinite(Number(this.options.range)) && pointDistance(this.scene, origin, center) > Number(this.options.range) + 1e-6) return false;
      if (this.options.avoidOccupied && occupied(this.tokens[i], position, ignore)) return false;
      return true;
    });
  }
  async go() {
    const sheet = this.reference.actor?.sheet ?? tokenDocument(this.reference).actor?.sheet;
    const restore = !!sheet?.rendered && this.options.minimizeSheet;
    try {
      if (restore) await sheet.minimize();
      const origin = this.options.centerpoint ? await resolveOriginPoint(this.options.centerpoint) : tokenCenter(this.reference);
      const reference = tokenDocument(this.reference);
      const config = { size: this.scene.grid.distance * reference.width,
        direction: reference._source.rotation ?? reference.rotation ?? 0,
        elevation: tokenCenter(this.reference).elevation,
        timeout: this.options.timeout, signal: this.options.signal, ...this.options.crosshairsConfig };
      this.result = await aimCrosshair({ token: this.reference, maxRange: this.options.range,
        centerpoint: origin, crosshairsConfig: config, customCallbacks: this.options.callbacks,
        checkCollision: this.options.checkCollision === true,
        validityFunctions: [point => this.validPositions(point, origin), ...(this.options.validityFunctions ?? [])] });
      if (this.result.cancelled || !this.result.valid) return this.result;
      if (!this.validPositions(this.result, origin)) return { ...this.result, valid: false, cancelled: true };
      const updates = this.positions(this.result);
      await Promise.all(this.tokens.map((token, i) => this.animate("pre", token, updates[i])));
      // Animations and socket handoff may yield. Check again immediately before submitting.
      if (!this.validPositions(this.result, origin)) return { ...this.result, valid: false, cancelled: true };
      let movement;
      if (this.options.isSynchronous === false) {
        movement = Object.assign({}, ...await Promise.all(updates.map(update => this.commit([update]))));
      } else movement = await this.commit(updates);
      await Promise.all(this.tokens.map((token, i) => movement?.[tokenDocument(token).id] === true
        ? this.animate("post", token, updates[i]) : undefined));
      return { ...this.result, movement };
    } finally {
      if (restore) await sheet.maximize();
    }
  }
  async animate(phase, token, spot) {
    const effect = (ClasspackTeleport.animations[this.options.animation] ?? ClasspackTeleport.animations.none)?.[phase];
    if (typeof effect === "function") await effect(token, spot);
  }
}
ClasspackTeleport.animations = { none: { pre: null, post: null } };
export { ClasspackTeleport };
