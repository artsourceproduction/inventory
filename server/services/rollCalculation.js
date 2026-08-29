// rollCalculation.js
// Phase 4B: real roll-calculation algorithm, per the production rules
// supplied for this job. Kept modular (one function, pure, no DB access)
// so the algorithm can be revised later without touching the route,
// the database layer, or the UI.
//
// Rules (as specified):
//  - Effective image size = image size + gap on BOTH sides of each
//    dimension: effective = image + (2 * gap).
//  - Images-per-row is computed for both orientations (normal and
//    rotated 90deg); the orientation whose full layout produces the
//    SHORTEST total print length is chosen (ties keep the image
//    as-is). Fitting more images in a single row does not by itself
//    mean less material is used once row count is accounted for, so
//    both full candidates are compared directly rather than picking
//    by per-row count alone.
//  - Rows required = ceil(quantity / images_per_row).
//  - Print length = rows required * the effective dimension running
//    down the roll length in the chosen orientation.
//  - Rolls required = ceil(print length / roll length).
//  - Media does not affect this calculation - no media-specific spacing
//    rule has been defined, so none is assumed.
//
// All inputs are expected in the units already used elsewhere in the
// app: image_width/height in cm, roll_width/roll_length in metres,
// gap_mm in millimetres. Internally everything is converted to mm for
// the geometry, then print length is converted to metres for the
// roll-count comparison (since roll_length is in metres).

function calculateRolls({ image_width, image_height, quantity, roll_width, roll_length, gap_mm }) {
  const imageWidthMm = Number(image_width) * 10;
  const imageHeightMm = Number(image_height) * 10;
  const gap = Number(gap_mm);
  const rollWidthMm = Number(roll_width) * 1000;
  const rollLengthM = Number(roll_length);
  const qty = Number(quantity);

  const effectiveWidthMm = imageWidthMm + (2 * gap);
  const effectiveHeightMm = imageHeightMm + (2 * gap);

  // Build a full candidate (images/row, rows, print length) for an
  // orientation, or null if the effective size doesn't fit across the
  // roll width at all in that orientation.
  function buildCandidate(acrossMm, alongMm) {
    const perRow = Math.floor(rollWidthMm / acrossMm);
    if (perRow <= 0) return null;
    const rows = Math.ceil(qty / perRow);
    return { imagesPerRow: perRow, rowsRequired: rows, printLengthMm: rows * alongMm };
  }

  const normal = buildCandidate(effectiveWidthMm, effectiveHeightMm);
  const rotated = buildCandidate(effectiveHeightMm, effectiveWidthMm);

  if (!normal && !rotated) {
    return {
      error: 'This image does not fit within the roll width, even rotated. ' +
             'Check the image size, gap, and roll width.',
    };
  }

  // "Most efficient" = shortest actual print length (least material/rolls),
  // not simply whichever orientation fits more per row - a higher
  // images-per-row count can still lose on total length once row count
  // is factored in, so both full candidates are compared directly.
  let orientation, chosen;
  if (normal && (!rotated || normal.printLengthMm <= rotated.printLengthMm)) {
    orientation = 'normal';
    chosen = normal;
  } else {
    orientation = 'rotated';
    chosen = rotated;
  }

  const printLengthM = chosen.printLengthMm / 1000;
  const rollsRequired = Math.ceil(printLengthM / rollLengthM);

  return {
    error: null,
    effective_width_mm: effectiveWidthMm,
    effective_height_mm: effectiveHeightMm,
    orientation,
    images_per_row: chosen.imagesPerRow,
    rows_required: chosen.rowsRequired,
    calculated_print_length: printLengthM,
    calculated_rolls: rollsRequired,
  };
}

module.exports = { calculateRolls };
