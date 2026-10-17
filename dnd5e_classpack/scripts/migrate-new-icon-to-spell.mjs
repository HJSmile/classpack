/**
 * Compatibility entry for the historical new-icon -> spell migration.
 * Its setting and reference rewrite now belong to migrations/index.mjs, bundled
 * into api.mjs. A GM starts world writes through dnd5eClasspack.migrations.run().
 * Loading this entry does not write world data.
 */
import "./content-sources/index.mjs";
