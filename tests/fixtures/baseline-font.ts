/**
 * G0/G7 deterministic fixture font: Inter (SIL OFL 1.1), provisioned for browser
 * baselines (docs/plans/declarative-layout-hardening.md §5.8, §11.1–11.2).
 *
 * Proof contract: `document.fonts.check` is NOT accepted. `loadFixtureFont`
 * returns the actual FontFace records after `document.fonts.load` resolves, and
 * each record must have status "loaded"; the harness additionally proves the
 * face rasterizes by comparing Canvas 2D widths against the generic fallback.
 * Network fetches happen once at provisioning time — this module only reads the
 * committed files, so repeated baselines never touch the network.
 */
export const FIXTURE_FONT_FILES = Object.freeze([
  {
    file: "Inter-Regular.woff2",
    weight: "400",
    sha256: "e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085",
  },
  {
    file: "Inter-Bold.woff2",
    weight: "700",
    sha256: "fa888127b6da015b65569f0351f3b5c391ad928904951f1c20e9f8462a8d95ea",
  },
]);
export const FIXTURE_FONT_FAMILY = "Ritween Fixture Inter";
export const FIXTURE_FONT_LICENSE = {
  name: "Inter",
  license: "SIL Open Font License 1.1",
  source: "https://github.com/rsms/inter (rsms.me/inter/font-files)",
  licenseFile: "tests/fixtures/fonts/LICENSE.txt",
};
export const FIXTURE_FONT_SHA256 = Object.freeze({
  "Inter-Regular.woff2":
    "e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085",
  "Inter-Bold.woff2":
    "fa888127b6da015b65569f0351f3b5c391ad928904951f1c20e9f8462a8d95ea",
  "LICENSE.txt":
    "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a",
});

/** Probe string measured for each weight; the bold face must rasterize wider. */
export const FONT_PROBE = "Ritween baseline 123";

/** Font stack used by the fixture theme; nothing else may satisfy it. */
export const fixtureFontFamily = `${FIXTURE_FONT_FAMILY}, monospace`;

export interface FixtureFontProof {
  family: string;
  faces: {
    file: string;
    weight: string;
    status: string;
    /** ArrayBuffer SHA-256, computed in-browser from the bytes handed to FontFace. */
    sha256: string;
    /** Whether the measured byte hash equals the committed fixture hash. */
    sha256MatchesFixture: boolean;
  }[];
  /** Per-weight probe widths; both must differ from the fallback and each other. */
  rasterProof: {
    probe: string;
    width400: number;
    width700: number;
    fallbackWidth: number;
  };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Registers and loads the fixture fonts, then proves the intended face is the
 * one that actually loaded and rasterizes. Throws instead of silently falling
 * back: a missing font is an environment blocker, not a degraded baseline.
 */
export async function loadFixtureFont(
  fontUrl: (file: string) => string,
): Promise<FixtureFontProof> {
  const faces: FixtureFontProof["faces"] = [];
  for (const { file, weight, sha256: expectedSha } of FIXTURE_FONT_FILES) {
    const response = await fetch(fontUrl(file));
    if (!response.ok)
      throw Error(
        `Fixture font ${file} is unavailable: HTTP ${response.status}.`,
      );
    const buffer = await response.arrayBuffer();
    const actualSha = await sha256Hex(buffer);
    if (actualSha !== expectedSha)
      throw Error(
        `Fixture font ${file} hash mismatch: expected ${expectedSha}, got ${actualSha}.`,
      );
    const face = new FontFace(FIXTURE_FONT_FAMILY, buffer, { weight });
    const loaded = await face.load();
    if (loaded !== face || face.status !== "loaded")
      throw Error(
        `Fixture font ${file} failed to load (status ${face.status}).`,
      );
    document.fonts.add(face);
    // The registered document set must contain THIS face for THIS weight.
    const matched = [...document.fonts].some(
      (candidate) =>
        candidate.family === FIXTURE_FONT_FAMILY &&
        candidate.weight === weight &&
        candidate.status === "loaded",
    );
    if (!matched)
      throw Error(
        `Fixture font ${weight} face is not loaded in the document font set.`,
      );
    faces.push({
      file,
      weight,
      status: face.status,
      sha256: actualSha,
      sha256MatchesFixture: actualSha === expectedSha,
    });
  }
  // Each declared weight must load through the document set by name.
  for (const { weight } of FIXTURE_FONT_FILES) {
    const query = `${weight} 16px ${FIXTURE_FONT_FAMILY}`;
    const loadedFaces = await document.fonts.load(query, "Ritween fixture 123");
    const matched = loadedFaces.some(
      (face) =>
        face.family === FIXTURE_FONT_FAMILY &&
        face.weight === weight &&
        face.status === "loaded",
    );
    if (!matched)
      throw Error(
        `document.fonts.load did not return the expected ${weight} fixture face.`,
      );
  }
  // Both weights must rasterize, distinctly from each other and from a
  // never-loaded generic fallback, proving each face is actually used.
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  context.font = `400 16px ${FIXTURE_FONT_FAMILY}`;
  const width400 = context.measureText(FONT_PROBE).width;
  context.font = `700 16px ${FIXTURE_FONT_FAMILY}`;
  const width700 = context.measureText(FONT_PROBE).width;
  context.font = "16px monospace";
  const fallbackWidth = context.measureText(FONT_PROBE).width;
  if (width400 === fallbackWidth || width700 === fallbackWidth)
    throw Error(
      "Fixture font rasterizes identically to the fallback; the face is not in use.",
    );
  if (width400 === width700)
    throw Error(
      "Fixture font 400 and 700 rasterize identically; the bold face is not in use.",
    );
  return {
    family: FIXTURE_FONT_FAMILY,
    faces,
    rasterProof: {
      probe: FONT_PROBE,
      width400,
      width700,
      fallbackWidth,
    },
  };
}
