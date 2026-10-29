export function av1CodecString(description: Uint8Array): string {
  const invalid = (message: string): never => {
    throw Error(`Invalid MP4: ${message}`);
  };
  if (description.length < 4 || description[0] !== 0x81)
    invalid("truncated or unsupported av1C configuration.");
  const profile = description[1] >> 5;
  const level = description[1] & 0x1f;
  const tier = description[2] >> 7;
  const highBitdepth = (description[2] >> 6) & 1;
  const twelveBit = (description[2] >> 5) & 1;
  if (
    profile > 2 ||
    (level > 23 && level !== 31) ||
    (tier !== 0 && level < 8) ||
    (twelveBit !== 0 && (profile !== 2 || highBitdepth === 0)) ||
    (description[3] & 0xe0) !== 0 ||
    ((description[3] & 0x10) === 0 && (description[3] & 0xf) !== 0)
  )
    invalid("invalid av1C profile, level, bit depth or reserved bits.");
  const bitDepth = twelveBit ? 12 : highBitdepth ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(bitDepth).padStart(2, "0")}`;
}
