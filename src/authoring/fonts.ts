/** Explicit, scene-owned font registration for conditional text. */
export interface StageFont {
  readonly family: string;
  /** Font URL, resolved by the author relative to their module. */
  readonly source: string;
  readonly weight?: string;
  readonly style?: string;
}

export function snapshotFonts(
  fonts: readonly StageFont[] = [],
): readonly StageFont[] {
  return Object.freeze(
    fonts.map((font) => {
      if (!font.family.trim() || !font.source.trim())
        throw Error("Stage font family and source must not be empty.");
      if (font.style !== undefined && font.style !== "normal")
        throw Error(
          "Stage fonts support only normal style; Text has no style selector.",
        );
      if (font.family !== font.family.trim() || /["',\\]/.test(font.family))
        throw Error(
          "Stage font family must be an unquoted single family name without surrounding whitespace.",
        );
      const weight = font.weight ?? "400";
      if (!/^[1-9]\d{0,3}$/.test(weight) || Number(weight) > 1000)
        throw Error(
          "Stage font weight must be an integer string from 1 to 1000.",
        );
      return Object.freeze({ ...font, weight, style: "normal" });
    }),
  );
}

// Active reservations only: removed with the last owner, never a text or font cache.
const active = new Map<string, { configuration: string; owners: number }>();

/** Scene-owned faces; conflicting active descriptors reject before registration. */
export class StageFonts {
  private readonly faces: FontFace[] = [];
  private disposed = false;
  private readonly reservations: string[] = [];
  async load(fonts: readonly StageFont[]): Promise<void> {
    try {
      fonts = snapshotFonts(fonts);
      const families = new Map<string, Map<string, string>>();
      for (const font of fonts) {
        const id = font.family.toLowerCase();
        const weights = families.get(id) ?? new Map<string, string>();
        if (weights.has(font.weight!) && weights.get(font.weight!) !== font.source)
          throw Error(`Conflicting active Stage font: ${font.family}.`);
        weights.set(font.weight!, font.source);
        families.set(id, weights);
      }
      const configurations = [...families].map(([id, weights]) => [
        id,
        JSON.stringify([...weights].sort(([a], [b]) => Number(a) - Number(b))),
      ] as const);
      // Validate the entire transaction before reserving or changing FontFaceSet.
      for (const [id, configuration] of configurations) {
        const existing = active.get(id);
        if (existing && existing.configuration !== configuration)
          throw Error(`Conflicting active Stage font: ${id} family configuration.`);
      }
      for (const [id, configuration] of configurations) {
        active.set(id, { configuration, owners: (active.get(id)?.owners ?? 0) + 1 });
        this.reservations.push(id);
      }
      await Promise.all(
        fonts.map(async (font) => {
          const face = new FontFace(
            font.family,
            `url(${JSON.stringify(font.source)})`,
            {
              weight: font.weight ?? "400",
              style: font.style ?? "normal",
            },
          );
          await face.load();
          if (this.disposed)
            throw Error("Stage was disposed during font loading.");
          document.fonts.add(face);
          this.faces.push(face);
        }),
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const face of this.faces) document.fonts.delete(face);
    this.faces.length = 0;
    for (const id of this.reservations) {
      const entry = active.get(id)!;
      if (--entry.owners === 0) active.delete(id);
    }
    this.reservations.length = 0;
  }
}
