function invalid(message: string): never {
  throw Error(`Invalid MP4: ${message}`);
}

export function hevcCodecString(
  description: Uint8Array,
  sampleEntry: "hvc1" | "hev1",
): string {
  if (description.length < 23 || description[0] !== 1)
    invalid("truncated or unsupported hvcC configuration.");
  if (
    (description[13] & 0xf0) !== 0xf0 ||
    (description[15] & 0xfc) !== 0xfc ||
    (description[16] & 0xfc) !== 0xfc ||
    (description[17] & 0xf8) !== 0xf8 ||
    (description[18] & 0xf8) !== 0xf8 ||
    (description[21] & 3) === 2
  )
    invalid("invalid hvcC reserved bits or NAL length size.");
  const view = new DataView(
    description.buffer,
    description.byteOffset,
    description.byteLength,
  );
  const parameterSets = new Set<number>();
  let offset = 23;
  for (let array = 0; array < description[22]; array++) {
    if (description.length - offset < 3) invalid("truncated hvcC NAL array.");
    const header = description[offset];
    if (header & 0x40) invalid("invalid hvcC NAL array reserved bit.");
    const type = header & 0x3f;
    const count = view.getUint16(offset + 1);
    offset += 3;
    for (let nal = 0; nal < count; nal++) {
      if (description.length - offset < 2)
        invalid("truncated hvcC NAL length.");
      const size = view.getUint16(offset);
      offset += 2;
      if (size < 2 || size > description.length - offset)
        invalid("hvcC NAL exceeds configuration bounds.");
      if (
        (description[offset] & 0x80) !== 0 ||
        ((description[offset] >> 1) & 0x3f) !== type ||
        (description[offset + 1] & 7) === 0
      )
        invalid("invalid hvcC NAL header.");
      parameterSets.add(type);
      offset += size;
    }
  }
  if (offset !== description.length)
    invalid("unexpected trailing hvcC configuration bytes.");
  if (
    sampleEntry === "hvc1" &&
    [32, 33, 34].some((type) => !parameterSets.has(type))
  )
    invalid("hvc1 requires VPS, SPS and PPS in hvcC.");

  const profileSpace = ["", "A", "B", "C"][description[1] >> 6];
  const profile = description[1] & 0x1f;
  let compatibility = 0;
  const flags = view.getUint32(2);
  for (let bit = 0; bit < 32; bit++)
    compatibility = (compatibility * 2 + ((flags >>> bit) & 1)) >>> 0;
  const tier = description[1] & 0x20 ? "H" : "L";
  const constraints = Array.from(description.subarray(6, 12));
  while (constraints.length && constraints[constraints.length - 1] === 0)
    constraints.pop();
  const suffix = constraints
    .map((byte) => `.${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
  return `${sampleEntry}.${profileSpace}${profile}.${compatibility.toString(16).toUpperCase()}.${tier}${description[12]}${suffix}`;
}
