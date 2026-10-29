interface GroupBox {
  type: string;
  payload: number;
  end: number;
}

const MAX_GROUP_ENTRIES = 1_000_000;

function invalid(message: string): never {
  throw Error(`Invalid MP4: ${message}`);
}

export function validateSampleGroups(
  view: DataView,
  boxes: readonly GroupBox[],
  sampleCount: number,
  kind: "video" | "audio",
): void {
  const descriptions = new Map<
    string,
    { count: number; defaultIndex: number }
  >();
  const mappings = new Map<string, GroupBox>();
  let entriesRemaining = MAX_GROUP_ENTRIES;
  const header = (box: GroupBox, versions: number[]) => {
    if (box.end - box.payload < 8)
      invalid(`truncated ${box.type} sample-group header.`);
    const version = view.getUint8(box.payload);
    if (!versions.includes(version))
      invalid(`unsupported ${box.type} sample-group version ${version}.`);
    if ((view.getUint32(box.payload) & 0xffffff) !== 0)
      invalid(`unsupported ${box.type} sample-group flags.`);
    const type = String.fromCharCode(
      ...new Uint8Array(view.buffer, view.byteOffset + box.payload + 4, 4),
    );
    if (kind !== "audio" || (type !== "roll" && type !== "prol"))
      invalid(`unsupported ${kind} sample grouping type ${type}.`);
    return { version, type };
  };

  for (const box of boxes) {
    if (box.type !== "sgpd" && box.type !== "sbgp") continue;
    const { version, type } = header(
      box,
      box.type === "sgpd" ? [0, 1, 2] : [0, 1],
    );
    if (box.type === "sbgp") {
      if (mappings.has(type)) invalid(`duplicate sbgp grouping type ${type}.`);
      mappings.set(type, box);
      continue;
    }
    if (descriptions.has(type))
      invalid(`duplicate sgpd grouping type ${type}.`);
    let offset = box.payload + 8;
    const read32 = () => {
      if (box.end - offset < 4) invalid("truncated sgpd sample-group table.");
      const value = view.getUint32(offset);
      offset += 4;
      return value;
    };
    const defaultLength = version >= 1 ? read32() : 2;
    const defaultIndex = version >= 2 ? read32() : 0;
    const count = read32();
    if (count > entriesRemaining)
      invalid("sample-group entry count exceeds parser limit.");
    entriesRemaining -= count;
    if (defaultIndex > count)
      invalid("sgpd default group index is out of range.");
    if (defaultLength !== 0 && defaultLength !== 2)
      invalid(`invalid ${type} sample-group description length.`);
    for (let i = 0; i < count; i++) {
      const length = defaultLength || read32();
      if (length !== 2 || box.end - offset < length)
        invalid(`invalid or truncated ${type} sample-group description.`);
      if (view.getInt16(offset) > 0)
        invalid(`positive ${type} recovery distances are unsupported.`);
      offset += length;
    }
    if (offset !== box.end) invalid("unexpected trailing sgpd bytes.");
    descriptions.set(type, { count, defaultIndex });
  }

  for (const [type, box] of mappings) {
    const version = view.getUint8(box.payload);
    let offset = box.payload + 8;
    if (version === 1) {
      if (box.end - offset < 4) invalid("truncated sbgp grouping parameter.");
      if (view.getUint32(offset) !== 0)
        invalid(`unsupported ${type} sbgp grouping parameter.`);
      offset += 4;
    }
    if (box.end - offset < 4) invalid("truncated sbgp entry count.");
    const count = view.getUint32(offset);
    offset += 4;
    if (count > entriesRemaining)
      invalid("sample-group entry count exceeds parser limit.");
    entriesRemaining -= count;
    if (box.end - offset !== count * 8) invalid("invalid sbgp table length.");
    let covered = 0;
    for (let i = 0; i < count; i++, offset += 8) {
      const run = view.getUint32(offset);
      const index = view.getUint32(offset + 4);
      if (run === 0 || run > sampleCount - covered)
        invalid(
          "sbgp sample count exceeds track samples or contains an empty run.",
        );
      covered += run;
      if (index > (descriptions.get(type)?.count ?? 0))
        invalid("sbgp group description index is out of range.");
    }
  }
}
