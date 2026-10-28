/** Byte limits are independent budgets, not a bound on total browser memory. */
export const MAX_ASSET_BYTES = 128 * 2 ** 20;
export const MAX_FULL_ASSET_BYTES = 128 * 2 ** 20;
export const MAX_MEDIA_SNAPSHOT_BYTES = 128 * 2 ** 20;
export const MAX_PCM_BYTES = 128 * 2 ** 20;
export const MAX_AUDIO_SOURCE_BYTES = 128 * 2 ** 20;
// Application policy inherited from native-media support, not a WebGPU limit.
// Counts RGBA8 media textures only; 64 MiB fits two 3840x2160 textures, not three.
// No cross-device calibration establishes this value as an optimal memory budget.
export const MAX_TEXTURE_BYTES = 64 * 2 ** 20;
