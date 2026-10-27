/**
 * AVC Level 4.2, matching the export codec avc1.42002a.
 * ITU-T H.264 Table A-1: at most 8704 macroblocks, and neither side
 * wider than floor(sqrt(MaxFS * 8)) macroblocks.
 */
export const H264_LEVEL_42_MAX_MACROBLOCKS = 8704;
const H264_LEVEL_42_MAX_SIDE_MBS = Math.floor(
  Math.sqrt(H264_LEVEL_42_MAX_MACROBLOCKS * 8),
);

/** Even dimensions that a Level 4.2 H.264 encoder is allowed to store.
 * @param {number} width
 * @param {number} height
 */
export function fitsH264Level42(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width < 2 || height < 2 || width % 2 !== 0 || height % 2 !== 0)
    return false;
  const across = Math.ceil(width / 16);
  const down = Math.ceil(height / 16);
  return (
    across <= H264_LEVEL_42_MAX_SIDE_MBS &&
    down <= H264_LEVEL_42_MAX_SIDE_MBS &&
    across * down <= H264_LEVEL_42_MAX_MACROBLOCKS
  );
}
